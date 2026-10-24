export default {
  shortcuts: {
    send: "Send a message",
    newline: "Insert a new line",
    sidebar: "Toggle chat sidebar",
    scroll: "Scroll chat to top / bottom (outside the input)",
  },
  chat: {
    send: "Send",
    stop: "Stop generating",
    input: "Enter your question",
    placeholder: "Ask a question about your organization’s knowledge…",
    newChat: "New chat",
    history: "My conversations",
    loading: "Loading conversation…",
    assistant: "Knowledge assistant",
    me: "Me",
    copy: "Copy answer",
    copied: "Copied",
    generating: "Generating",
    unfinished: "Generation incomplete",
    grounded: "Answered from knowledge",
    thinking: "Searching knowledge and thinking…",
  },

  navigation: {
    knowledgeAssistant: "Knowledge assistant",
    management: "Administration",
    appearance: "Appearance",
    system: "System",
    light: "Light",
    dark: "Dark",
    platform: "Platform administration",
    tenant: "Current organization",
    platformAdmin: "Platform administrator",
    admin: "Organization administrator",
    member: "Member",
    logout: "Sign out",
    open: "Open menu",
    close: "Close menu",
    preferences: "Interface preferences",
  },
  pages: {
    chat: "Knowledge chat",
    knowledge: "Knowledge management",
    users: "Users and roles",
    connections: "AI connections",
    platformConnections: "Platform AI connections",
    tenants: "Organizations",
    knowledgeDescription:
      "Manage documents in authorized libraries. Files and text follow the same permission rules.",
    usersDescription: "Manage users, roles and access in your organization.",
    connectionsDescription:
      "Manage organization connections and available shared platform connections.",
    platformConnectionsDescription:
      "Manage shared chat and embedding connections and their defaults.",
    tenantsDescription: "Manage independent organizations and their status.",
  },
  markdown: {
    copyBlock: "Copy block",
    copied: "Copied",
    copyFailed: "Could not copy. Select the code to copy it.",
    richCopy: "Copy formatted answer",
  },
  files: {
    loading: "Loading supported file types…",
    unavailable: "Could not load supported file types. Retry before uploading.",
    supported:
      "Preset formats: {{extensions}}. Other text files are detected by the document processor. Maximum file size: {{size}} MB.",
    invalid: "This file type is not supported.",
    tooLarge: "The file exceeds the {{size}} MB limit.",
  },
  rag: {
    rerank: "Rerank retrieved results",
    cache: "Reuse this document’s embedding cache",
    cacheHint:
      "Reuse requires the same organization, document, model and content. The cache is never shared across documents or users.",
  },
};
