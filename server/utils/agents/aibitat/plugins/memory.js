const { Deduplicator } = require("../utils/dedupe");

const memory = {
  name: "rag-memory",
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          tracker: new Deduplicator(),
          name: this.name,
          description:
            "Search your authorized knowledge libraries for relevant information, or save information to an authorized library. Use search to find answers in uploaded documents, embedded files, or previously saved knowledge. Use store only when explicitly asked to remember or save something.",
          examples: [
            {
              prompt: "Check my files for information about the project",
              call: JSON.stringify({
                action: "search",
                content: "<project information to search for>",
              }),
            },
            {
              prompt: "What do you know about Plato's motives?",
              call: JSON.stringify({
                action: "search",
                content: "What are the facts about Plato's motives?",
              }),
            },
            {
              prompt: "Remember that you are a robot",
              call: JSON.stringify({
                action: "store",
                content: "I am a robot, the user told me that i am.",
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["search", "store"],
                description:
                  "The action we want to take to search for existing similar context or storage of new context.",
              },
              content: {
                type: "string",
                description:
                  "The plain text to search our local documents with or to store in our vector database.",
              },
              libraryId: {
                type: "string",
                description: "Target authorized knowledge library for store. Required when there is not exactly one private library.",
              },
            },
            additionalProperties: false,
          },
          handler: async function ({ action = "", content = "", libraryId = null }) {
            try {
              const { isDuplicate } = this.tracker.isDuplicate(this.name, {
                action,
                content,
                libraryId,
              });
              if (isDuplicate)
                return `This was a duplicated call and it's output will be ignored.`;

              let response = "There was nothing to do.";
              if (action === "search") response = await this.search(content);
              if (action === "store") response = await this.store(content, libraryId);

              this.tracker.trackRun(this.name, { action, content, libraryId });
              return response;
            } catch (error) {
              console.log(error);
              return `There was an error while calling the function. ${error.message}`;
            }
          },
          search: async function (query = "") {
            try {
              const ctx =
                await require("../../../../enterprise/execution-context").loadExecutionContext(
                  this.super.handlerProps.ctx
                );
              const providers = require("../../../../enterprise/providers");
              const { retrieve } = require("../../../../enterprise/rag");
              const connection = await providers.resolveConnection(
                ctx,
                "embedding"
              );
              const sources = await retrieve(ctx, query, connection);
              const contextTexts = sources.map((source) => source.text);

              if (contextTexts.length === 0) {
                this.super.introspect(
                  `${this.caller}: I didn't find anything locally that would help answer this question.`
                );
                return "There was no additional context found for that query. We should search the web for this information.";
              }

              this.super.introspect(
                `${this.caller}: Found ${contextTexts.length} additional piece of context to help answer this question.`
              );

              this.super.addCitation?.(sources);

              let combinedText = "Additional context for query:\n";
              for (const text of contextTexts) combinedText += text + "\n\n";
              return combinedText;
            } catch (error) {
              this.super.handlerProps.log(
                `memory.search raised an error. ${error.message}`
              );
              return `An error was raised while searching the vector database. ${error.message}`;
            }
          },
          store: async function (content = "", libraryId = null) {
            try {
              const ctx =
                await require("../../../../enterprise/execution-context").loadExecutionContext(
                  this.super.handlerProps.ctx
                );
              if (!libraryId) {
                const { Document } = require("../../../../models/documents");
                const libraries = await require("../../../prisma").ep_libraries.findMany({
                  where: {
                    AND: [Document.libraryScope(ctx), {
                      grants: { none: { tenantId: { not: null } } },
                    }],
                  },
                  take: 2,
                });
                if (libraries.length !== 1)
                  return "Ask the user to choose an authorized knowledge library before saving, then pass its libraryId.";
                libraryId = libraries[0].id;
              }
              const result = await require("../../../../enterprise/knowledge").submitText(ctx, {
                libraryId,
                title: "agent-memory.txt",
                content,
                metadata: { docAuthor: "@agent", docSource: "a text entry saved by the agent" },
              });
              this.super.introspect(
                `${this.caller}: ${result.approvalRequired ? "Submitted this knowledge change for administrator approval." : "Saved this content to the authorized knowledge library."}`
              );
              return result.approvalRequired
                ? "The knowledge change awaits administrator approval and is not searchable yet."
                : "The content was saved to the knowledge library and will be searchable after indexing completes.";
            } catch (error) {
              this.super.handlerProps.log(
                `memory.store raised an error. ${error.message}`
              );
              return `Let the user know this action was not successful. An error was raised while storing data in the vector database. ${error.message}`;
            }
          },
        });
      },
    };
  },
};

module.exports = {
  memory,
};
