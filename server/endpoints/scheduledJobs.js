const { ScheduledJob } = require("../models/scheduledJob");
const { ScheduledJobRun } = require("../models/scheduledJobRun");
const {
  authenticate: validatedRequest,
  wrap,
  owned,
} = require("../utils/middleware/externalIdentity");
const { fail } = require("../enterprise/auth");
const taskScope = wrap(async (req, res, next) => {
  if (req.ep.identity === "platform") return next();
  let job;
  if (req.params.runId) {
    const run = await ScheduledJobRun.get(
      { id: Number(req.params.runId) },
      { job: true }
    );
    job = run?.job;
  } else if (req.params.id)
    job = await ScheduledJob.get({ id: Number(req.params.id) });
  if (!req.params.id && !req.params.runId) return next();
  if (!job || job.tenantId !== req.ep.tenantId)
    throw fail(404, "Task not found");
  if (owned(req.ep, job)) return next();
  const stopping =
    req.params.action === "kill" ||
    (req.method === "PUT" &&
      Object.keys(req.body || {}).length === 1 &&
      req.body.enabled === false) ||
    (req.path.endsWith("/toggle") && job.enabled);
  if (req.ep.role === "admin" && stopping) {
    req.manageStopOnly = true;
    return next();
  }
  throw fail(404, "Task not found");
});
const { reqBody, safeJsonParse } = require("../utils/http");
const { BackgroundService } = require("../utils/BackgroundWorkers");
const { Telemetry } = require("../models/telemetry");

// BackgroundService is a singleton, so `new BackgroundService()` anywhere in
// the codebase returns the same instance that `server/index.js` booted. We
// grab that reference once and reuse it across handlers.
const backgroundService = new BackgroundService();

function scheduledJobEndpoints(app) {
  if (!app) return;

  app.get(
    "/scheduled-jobs/managed",
    [validatedRequest],
    async (req, res, next) => {
      try {
        if (req.ep.identity !== "platform" && req.ep.role !== "admin")
          throw fail(403, "需要管理员权限");
        const jobs = await ScheduledJob.where(
          req.ep.identity === "platform" ? {} : { tenantId: req.ep.tenantId }
        );
        res.json({
          jobs: jobs.map(
            ({ id, tenantId, userId, name, enabled, schedule }) => ({
              id,
              tenantId,
              userId,
              name,
              enabled,
              schedule,
            })
          ),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // List available tools for job configuration
  app.get(
    "/scheduled-jobs/available-tools",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        let identity = request.ep;
        if (identity.identity === "platform" && request.query.userId) {
          identity = await require("../enterprise/auth").context(
            request.query.userId
          );
          if (identity.tenantId !== request.query.tenantId)
            throw fail(400, "执行用户不属于目标企业");
        }
        const tools =
          await require("../enterprise/execution-context").runExecution(
            identity,
            () => ScheduledJob.availableTools()
          );
        return response.status(200).json({ tools });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).json({ tools: [] });
      }
    }
  );

  // Get a single run detail
  app.get(
    "/scheduled-jobs/runs/:runId",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const run = await ScheduledJobRun.get({
          id: Number(request.params.runId),
        });
        if (!run) {
          return response
            .status(404)
            .json({ run: null, error: "Run not found" });
        }

        const job = await ScheduledJob.get({ id: run.jobId });
        return response.status(200).json({
          run: {
            ...run,
            result: safeJsonParse(run.result, null),
          },
          job,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  // Mark a run as read or continue in thread, or kill a running or queued job run
  app.post(
    "/scheduled-jobs/runs/:runId/:action",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const { action } = request.params;

        if (!["read", "continue", "kill"].includes(action))
          throw new Error("Invalid action");

        if (action === "read") {
          await ScheduledJobRun.markRead(Number(request.params.runId));
          return response.status(200).json({ success: true });
        }

        if (action === "continue") {
          const { thread, error } = await ScheduledJobRun.continueInThread(
            Number(request.params.runId)
          );
          if (error) return response.status(500).json({ error });

          return response.status(200).json({
            conversationId: thread.id,
            threadSlug: thread.slug,
          });
        }

        if (action === "kill") {
          const run = await ScheduledJobRun.get({
            id: Number(request.params.runId),
          });
          if (!run)
            return response.status(404).json({ error: "Run not found" });
          if (!["queued", "running"].includes(run.status)) {
            return response.status(400).json({
              error: "Only running or queued jobs can be killed",
            });
          }

          backgroundService.killRun(run.jobId, run.id);
          // Windows terminates workers without running their SIGTERM handler.
          await ScheduledJobRun.kill(run.id);
          return response.status(200).json({ success: true });
        }
      } catch {
        response.sendStatus(500);
      }
    }
  );

  // List all scheduled jobs
  app.get(
    "/scheduled-jobs",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const jobs = await ScheduledJob.where(
          request.ep.identity === "platform"
            ? {}
            : { tenantId: request.ep.tenantId, userId: request.ep.userId },
          null,
          null,
          {
            runs: {
              take: 1,
              orderBy: { startedAt: "desc" },
            },
          }
        );

        const jobsWithStatus = jobs.map(({ runs, ...job }) => ({
          ...job,
          latestRun: runs[0] || null,
        }));

        return response.status(200).json({ jobs: jobsWithStatus });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  // Create a new scheduled job
  app.post(
    "/scheduled-jobs/new",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const { name, prompt, tools, schedule } = reqBody(request);
        let execution = request.ep;
        if (request.ep.identity === "platform") {
          execution = await require("../enterprise/auth").context(
            request.body.userId
          );
          if (execution.tenantId !== request.body.tenantId)
            return response
              .status(400)
              .json({ error: "请选择该企业的有效执行用户" });
        }
        let errorMessage = null;

        if (!name?.trim()) {
          errorMessage = "Name is required";
        } else if (!prompt?.trim()) {
          errorMessage = "Prompt is required";
        } else if (!schedule?.trim()) {
          errorMessage = "Schedule is required";
        } else if (!ScheduledJob.isValidCron(schedule)) {
          errorMessage = "Invalid cron expression";
        } else if (tools?.length > 0 && !Array.isArray(tools)) {
          errorMessage = "Tools must be an array";
        }
        if (errorMessage)
          return response.status(400).json({
            job: null,
            error: errorMessage,
          });

        // New jobs default to enabled, so creating one always counts as an
        // activation. Reject if it would push us past the configured cap.
        const activation = await ScheduledJob.canActivate();
        if (!activation.allowed) {
          return response.status(400).json({
            job: null,
            error: `Cannot create: maximum of ${activation.limit} active scheduled jobs reached. Disable another job first.`,
          });
        }

        const { job, error } = await ScheduledJob.create({
          name: name.trim(),
          prompt: prompt.trim(),
          tools: tools || null,
          schedule: schedule.trim(),
          tenantId: execution.tenantId,
          userId: execution.userId,
        });

        if (error) {
          return response.status(400).json({ job: null, error });
        }

        backgroundService.addScheduledJob(job);
        Telemetry.sendTelemetry("scheduled_job_created").catch(() => {});
        return response.status(201).json({ job, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  // Get a single scheduled job
  app.get(
    "/scheduled-jobs/:id",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const job = await ScheduledJob.get({
          id: Number(request.params.id),
        });
        if (!job) {
          return response
            .status(404)
            .json({ job: null, error: "Job not found" });
        }
        return response.status(200).json({ job });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  // Update a scheduled job
  app.put(
    "/scheduled-jobs/:id",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const { name, prompt, tools, schedule, enabled } = reqBody(request);
        const updates = {};

        if (name !== undefined) updates.name = String(name).trim();
        if (prompt !== undefined) updates.prompt = String(prompt).trim();
        if (tools !== undefined) updates.tools = tools;
        if (enabled !== undefined) updates.enabled = Boolean(enabled);
        if (schedule !== undefined) {
          if (!ScheduledJob.isValidCron(schedule)) {
            return response
              .status(400)
              .json({ job: null, error: "Invalid cron expression" });
          }
          updates.schedule = String(schedule).trim();
        }

        // If this update would activate the job, enforce the active-jobs cap.
        // We pass excludeId so a re-save of an already-enabled job is not
        // double-counted against the limit.
        if (updates.enabled === true) {
          const activation = await ScheduledJob.canActivate({
            excludeId: Number(request.params.id),
          });
          if (!activation.allowed) {
            return response.status(400).json({
              job: null,
              error: `Cannot enable: maximum of ${activation.limit} active scheduled jobs reached. Disable another job first.`,
            });
          }
        }

        const { job, error } = await ScheduledJob.update(
          Number(request.params.id),
          updates
        );

        if (error) {
          return response.status(400).json({ job: null, error });
        }

        await backgroundService.syncScheduledJob(job.id);

        return response
          .status(200)
          .json(
            request.manageStopOnly ? { success: true } : { job, error: null }
          );
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  // Delete a scheduled job
  app.delete(
    "/scheduled-jobs/:id",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        backgroundService.removeScheduledJob(Number(request.params.id));

        const success = await ScheduledJob.delete(Number(request.params.id));
        return response.status(200).json({ success });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  // Toggle enable/disable
  app.post(
    "/scheduled-jobs/:id/toggle",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const job = await ScheduledJob.get({
          id: Number(request.params.id),
        });
        if (!job) {
          return response.status(404).json({ error: "Job not found" });
        }

        // Toggling a disabled job to enabled is an activation — enforce the cap.
        // Disabling never needs a check.
        if (!job.enabled) {
          const activation = await ScheduledJob.canActivate({
            excludeId: job.id,
          });
          if (!activation.allowed) {
            return response.status(400).json({
              job: null,
              error: `Cannot enable: maximum of ${activation.limit} active scheduled jobs reached. Disable another job first.`,
            });
          }
        }

        const { job: updated } = await ScheduledJob.update(job.id, {
          enabled: request.manageStopOnly ? false : !job.enabled,
        });

        await backgroundService.syncScheduledJob(job.id);

        return response
          .status(200)
          .json(request.manageStopOnly ? { success: true } : { job: updated });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  // Manual trigger — runs the job immediately
  app.post(
    "/scheduled-jobs/:id/trigger",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const job = await ScheduledJob.get({
          id: Number(request.params.id),
        });
        if (!job) {
          return response.status(404).json({ error: "Job not found" });
        }

        const run = await backgroundService.enqueueScheduledJob(job.id);
        return response
          .status(200)
          .json({ success: true, skipped: !run, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );

  // List runs for a job
  app.get(
    "/scheduled-jobs/:id/runs",
    [validatedRequest, taskScope],
    async (request, response) => {
      try {
        const runs = await ScheduledJobRun.where(
          { jobId: Number(request.params.id) },
          50,
          { startedAt: "desc" }
        );
        return response.status(200).json({ runs });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500);
      }
    }
  );
}

module.exports = { scheduledJobEndpoints };
