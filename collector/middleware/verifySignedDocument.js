function verifySignedDocument(verifySignature) {
  return (request, response, next) => {
    const signature = request.header("X-Integrity");
    if (
      !signature ||
      !request.rawBody ||
      !verifySignature(signature, request.rawBody)
    ) {
      return response.status(401).json({ error: "解析请求签名验证失败" });
    }
    next();
  };
}

module.exports = { verifySignedDocument };
