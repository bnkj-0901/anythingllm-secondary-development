// Every original authenticated endpoint uses the same host-bound SaaS session.
// Single-user development bypasses are not valid in a multi-tenant service.
const { authenticate } = require("../../enterprise/auth");
module.exports = { validatedRequest: authenticate };
