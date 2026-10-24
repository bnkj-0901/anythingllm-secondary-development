const swaggerAutogen = require("swagger-autogen")({ openapi: "3.0.0" });
const fs = require("fs");
const path = require("path");

const doc = {
  info: {
    version: "1.0.0",
    title: "AnythingLLM Developer API",
    description:
      "API endpoints that enable programmatic reading, writing, and updating of your AnythingLLM instance. UI supplied by Swagger.io.",
  },
  // Swagger-autogen does not allow us to use relative paths as these will resolve to
  // http:///api in the openapi.json file, so we need to monkey-patch this post-generation.
  host: "/api",
  schemes: ["http"],
  securityDefinitions: {
    BearerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    },
  },
  security: [{ BearerAuth: [] }],
  definitions: {
    InvalidAPIKey: {
      message: "Invalid API Key",
    },
  },
};

const outputFile = path.resolve(__dirname, "./openapi.json");
const endpointsFiles = [
  "../endpoints/api/index.js",
  "../endpoints/api/auth/index.js",
  "../endpoints/api/document/index.js",
  "../endpoints/api/userManagement/index.js",
  "../endpoints/api/openai/index.js",
  "../endpoints/api/embed/index.js",
  "../enterprise/knowledge.js",
  "../enterprise/rag.js",
].map((file) => path.resolve(__dirname, file).replace(/\\/g, "/"));

// Generate documentation from the same route registry used by the server.
// Shared files may still contain legacy handlers; only mounted API methods
// belong in the published specification.
process.env.STORAGE_DIR ||= path.resolve(__dirname, "../storage");
const router = require("express").Router();
const resources =
  require("../endpoints/api").registerDeveloperApiRoutes(router);
const mounted = new Map();
for (const [source, prefix] of [
  [router, ""],
  [resources, "/v1"],
]) {
  for (const layer of source.stack) {
    if (!layer.route) continue;
    for (const route of [layer.route.path].flat()) {
      if (
        typeof route !== "string" ||
        route.includes("*") ||
        route.startsWith("/platform/")
      )
        continue;
      const name = `${prefix}${route}`.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const methods = mounted.get(name) || new Set();
      Object.entries(layer.route.methods)
        .filter(([, enabled]) => enabled)
        .forEach(([method]) => methods.add(method));
      mounted.set(name, methods);
    }
  }
}

swaggerAutogen(outputFile, endpointsFiles, doc).then(({ data }) => {
  if (!data) throw new Error("Swagger generation failed");
  const paths = {};
  for (const [name, methods] of mounted) {
    const generated =
      data.paths[name] || data.paths[name.replace(/^\/v1/, "")] || {};
    paths[name] = {};
    for (const method of methods) {
      paths[name][method] = generated[method] || {
        tags: [
          name.includes("/libraries") || name.includes("/documents")
            ? "Knowledge"
            : "Personal conversations",
        ],
        parameters: [...name.matchAll(/\{([^}]+)\}/g)].map((match) => ({
          name: match[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        })),
        responses: { 200: { description: "Successful response" } },
      };
    }
  }
  data.paths = paths;
  // Remove Authorization parameters from arguments.
  for (const path of Object.keys(data.paths)) {
    if (data.paths[path].hasOwnProperty("get")) {
      let parameters = data.paths[path].get?.parameters || [];
      parameters = parameters.filter((arg) => arg.name !== "Authorization");
      data.paths[path].get.parameters = parameters;
    }

    if (data.paths[path].hasOwnProperty("post")) {
      let parameters = data.paths[path].post?.parameters || [];
      parameters = parameters.filter((arg) => arg.name !== "Authorization");
      data.paths[path].post.parameters = parameters;
    }

    if (data.paths[path].hasOwnProperty("delete")) {
      let parameters = data.paths[path].delete?.parameters || [];
      parameters = parameters.filter((arg) => arg.name !== "Authorization");
      data.paths[path].delete.parameters = parameters;
    }
  }

  const openApiSpec = {
    ...data,
    servers: [
      {
        url: "/api",
      },
    ],
  };
  fs.writeFileSync(outputFile, JSON.stringify(openApiSpec, null, 2), {
    encoding: "utf-8",
    flag: "w",
  });
  console.log(`Swagger-autogen:  \x1b[32mPatched servers.url ✔\x1b[0m`);
});
