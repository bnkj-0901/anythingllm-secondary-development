const { User } = require("../../../models/user");
const { TemporaryAuthToken } = require("../../../models/temporaryAuthToken");
const { multiUserMode } = require("../../../utils/http");
const { manager } = require("../../../utils/middleware/externalIdentity");
const {
  simpleSSOEnabled,
} = require("../../../utils/middleware/simpleSSOEnabled");
const { validApiKey } = require("../../../utils/middleware/validApiKey");
const { userHandlers } = require("../../../enterprise/auth");
const store = require("../../../enterprise/store");

function apiUserManagementEndpoints(app) {
  if (!app) return;
  const currentTenant = (req, _res, next) => {
    req.userTenantId = req.ep.tenantId;
    next();
  };
  app.get(
    "/v1/admin/users",
    validApiKey,
    manager,
    currentTenant,
    userHandlers.list
  );
  app.post(
    ["/v1/users", "/v1/admin/users/new"],
    validApiKey,
    manager,
    currentTenant,
    userHandlers.create
  );
  app.post(
    "/v1/admin/users/:id",
    validApiKey,
    manager,
    currentTenant,
    userHandlers.update
  );
  app.patch(
    "/v1/users/:id",
    validApiKey,
    manager,
    currentTenant,
    userHandlers.update
  );
  app.get("/v1/admin/is-multi-user-mode", validApiKey, (_req, res) =>
    res.json({ isMultiUser: true })
  );

  app.get("/v1/users", [validApiKey, manager], async (request, response) => {
    /*
      #swagger.tags = ['User Management']
      #swagger.description = 'List all users'
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                users: [
                  {
                    "id": 1,
                    "username": "john_doe",
                    "role": "admin"
                  },
                  {
                    "id": 2,
                    "username": "jane_smith",
                    "role": "default"
                  }
                ]
              }
            }
          }
        }
      }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Permission denied.",
    }
      */
    try {
      if (!multiUserMode(response))
        return response
          .status(401)
          .send("Instance is not in Multi-User mode. Permission denied.");

      const users = await User.list(request.ep.tenantId, store);
      const filteredUsers = users.map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role,
      }));
      response.status(200).json({ users: filteredUsers });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/v1/users/:id/issue-auth-token",
    [validApiKey, simpleSSOEnabled],
    async (request, response) => {
      /*
      #swagger.tags = ['User Management']
      #swagger.description = 'Issue a temporary auth token for a user'
      #swagger.parameters['id'] = {
        in: 'path',
        description: 'The ID of the user to issue a temporary auth token for',
        required: true,
        type: 'string'
      }
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                token: "1234567890",
                loginPath: "/sso/simple?token=1234567890"
              }
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Permission denied.",
    }
      */
      try {
        const userId = Number(request.params.id);
        const user =
          userId === request.ep.userId
            ? await User.get(request.ep.tenantId, userId, store)
            : null;
        if (!user)
          return response.status(404).json({ error: "User not found" });

        const { token, error } = await TemporaryAuthToken.issue(userId);
        if (error) return response.status(500).json({ error: error });

        response.status(200).json({
          token: String(token),
          loginPath: `/sso/simple?token=${token}`,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { apiUserManagementEndpoints };
