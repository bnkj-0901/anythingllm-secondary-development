const { Telemetry } = require("../models/telemetry");
const {
  WorkspaceAgentInvocation,
} = require("../models/workspaceAgentInvocation");
const { AgentHandler } = require("../utils/agents");
const {
  WEBSOCKET_BAIL_COMMANDS,
} = require("../utils/agents/aibitat/plugins/websocket");
const { safeJsonParse } = require("../utils/http");
const { requireAuth } = require("../enterprise/auth");
const { refreshContext } = require("../enterprise/auth");
const { runExecution } = require("../enterprise/execution-context");

// Setup listener for incoming messages to relay to socket so it can be handled by agent plugin.
function relayToSocket(message) {
  // Binary frames arrive as a Buffer - normalize so every handler parses a string.
  message = String(message);
  // Tool toggles can arrive while the agent is paused awaiting feedback/approval,
  // so handle them first. The handler ignores (returns false for) any other message.
  if (this.handleToolToggle?.(message)) return;
  if (this.handleFeedback) return this?.handleFeedback?.(message);
  if (this.handleToolApproval) return this?.handleToolApproval?.(message);
  if (this.handleClarificationResponse)
    return this?.handleClarificationResponse?.(message);
  this.checkBailCommand(message);
}

function agentWebsocket(app) {
  if (!app) return;

  app.ws("/api/agent-invocation/:uuid", function (socket, request) {
    const timeout = setTimeout(
      () => socket.close(1008, "Authentication required"),
      10000
    );
    timeout.unref?.();
    socket.once("message", async (message) => {
      clearTimeout(timeout);
      try {
        const frame = safeJsonParse(String(message), {});
        if (frame.type !== "authenticate" || typeof frame.token !== "string")
          throw new Error("Authentication required");
        request.headers.authorization = `Bearer ${frame.token}`;
        await new Promise((resolve, reject) =>
          requireAuth(request, { locals: {} }, (error) =>
            error ? reject(error) : resolve()
          )
        );
        const agentHandler = await new AgentHandler({
          uuid: String(request.params.uuid),
          ctx: request.ep,
        }).init();

        if (!agentHandler.invocation) {
          socket.close();
          return;
        }

        socket.on("message", async (data) => {
          try {
            await refreshContext(request.ep);
            const frame = safeJsonParse(String(data), {});
            await require("./agentFileServer").validateGeneratedImageAccess(
              frame.attachments || [],
              request.ep
            );
            await runExecution(request.ep, () =>
              relayToSocket.call(socket, data)
            );
          } catch {
            socket.close(1008, "Session expired");
          }
        });
        socket.on("close", () => {
          // Abort the running agent loop (stop button, tab close, disconnect) so
          // in-flight LLM requests are cancelled and no further turns run.
          agentHandler.aibitat?.abort();
          agentHandler.closeAlert();
          WorkspaceAgentInvocation.close(String(request.params.uuid));
          return;
        });

        socket.checkBailCommand = (data) => {
          const content = safeJsonParse(data)?.feedback;
          if (WEBSOCKET_BAIL_COMMANDS.includes(content)) {
            agentHandler.log(
              `User invoked bail command while processing. Closing session now.`
            );
            // aibitat may not exist yet if the bail arrives while the session
            // is still being built - closing the socket alone is enough then.
            agentHandler.aibitat?.abort();
            socket.close();
            return;
          }
        };

        await Telemetry.sendTelemetry("agent_chat_started");
        await agentHandler.createAIbitat({ socket });
        // Socket can close while aibitat is being built - don't start a session nobody is listening to.
        if (socket.readyState !== socket.OPEN) return;
        await agentHandler.startAgentCluster();
      } catch (e) {
        console.error(e.message, e);
        if (socket.readyState === socket.OPEN)
          socket?.send(
            JSON.stringify({ type: "wssFailure", content: e.message })
          );
        socket?.close();
      }
    });
    socket.once("close", () => clearTimeout(timeout));
  });
}

module.exports = { agentWebsocket };
