// Local-only fixtures for the product preview. No network or model calls.
export const DEMO_STORAGE_KEY = "enterprise-ai-preview-v2";

export const demoUsers = [
  { id: "lin", name: "林晓", role: "管理员" },
  { id: "chen", name: "陈亦", role: "普通成员" },
  { id: "zhou", name: "周宁", role: "普通成员" },
];

export const demoLibraries = [
  {
    id: "product",
    name: "产品资料",
    scope: "public",
    ownerId: null,
    description: "产品说明、安装指南与售后服务",
    icon: "goods",
    color: "#237b61",
    canUpload: true,
  },
  {
    id: "business",
    name: "业务流程",
    scope: "public",
    ownerId: null,
    description: "采购、销售与日常业务规范",
    icon: "layers",
    color: "#5778ac",
    canUpload: true,
  },
  {
    id: "people",
    name: "人事制度",
    scope: "public",
    ownerId: null,
    description: "报销、考勤与员工服务",
    icon: "user",
    color: "#b58b50",
    canUpload: true,
  },
  {
    id: "private-lin",
    name: "个人笔记",
    scope: "private",
    ownerId: "lin",
    description: "自己的巡检记录与工作经验",
    icon: "lock-on",
    color: "#80659e",
    canUpload: true,
  },
  {
    id: "private-chen",
    name: "个人笔记",
    scope: "private",
    ownerId: "chen",
    description: "自己的客户跟进计划与工作笔记",
    icon: "lock-on",
    color: "#80659e",
    canUpload: true,
  },
  {
    id: "private-zhou",
    name: "个人笔记",
    scope: "private",
    ownerId: "zhou",
    description: "自己的入职跟进记录与待办",
    icon: "lock-on",
    color: "#80659e",
    canUpload: true,
  },
];

export const demoDocuments = [
  {
    id: "doc-install",
    name: "智能网关安装与验收指南.pdf",
    libraryId: "product",
    type: "pdf",
    size: "2.4 MB",
    updatedAt: "2026-10-20 09:30",
    status: "ready",
    owner: "林晓",
    uploadedBy: "lin",
    keywords: ["安装", "验收", "网关", "接线"],
    content:
      "安装智能网关前，请先核对设备型号、电源规格及配件清单。\n\n1. 在断电状态下连接电源线与网络线，确认接线牢固。\n2. 通电后检查电源及网络指示灯，通过管理页面完成网络配置。\n3. 核对设备编号，测试数据采集与上报功能。\n4. 验收时记录设备编号、安装位置和测试结果，由现场负责人确认。",
  },
  {
    id: "doc-return",
    name: "售后服务与退换货规范.docx",
    libraryId: "product",
    type: "docx",
    size: "856 KB",
    updatedAt: "2026-10-19 16:20",
    status: "ready",
    owner: "陈亦",
    uploadedBy: "chen",
    keywords: ["售后", "退货", "换货", "退换", "维修", "保修"],
    content:
      "客户申请退换货时，需要提供订单编号、设备编号、问题描述及相关照片。\n\n1. 客服核对购买记录和服务期限，登记售后申请。\n2. 技术人员判断故障原因，确认维修或退换方案。\n3. 审核通过后通知客户寄回，仓库签收并完成检测。\n4. 根据检测结果办理换货或退款，通知客户处理结果。\n\n具体期限和费用以双方合同及审批结果为准。",
  },
  {
    id: "doc-spec",
    name: "产品选型与规格说明.pdf",
    libraryId: "product",
    type: "pdf",
    size: "3.1 MB",
    updatedAt: "2026-10-18 14:10",
    status: "ready",
    owner: "陈亦",
    uploadedBy: "chen",
    keywords: ["选型", "规格", "型号", "参数"],
    content:
      "标准型网关适用于常规数据采集场景；工业型网关适用于需要更宽工作温度和更高防护等级的现场。选型时应确认采集协议、设备数量、网络条件及安装环境。最终参数请以对应型号的正式规格书为准。",
  },
  {
    id: "doc-purchase",
    name: "采购申请与审批流程.pdf",
    libraryId: "business",
    type: "pdf",
    size: "1.2 MB",
    updatedAt: "2026-10-20 10:15",
    status: "ready",
    owner: "林晓",
    uploadedBy: "lin",
    keywords: ["采购", "请购", "供应商", "审批"],
    content:
      "采购申请需填写物料、规格、数量、期望到货时间及采购原因，并附上报价资料。\n\n1. 申请人提交采购需求，由部门负责人确认。\n2. 采购人员比价并确定供应商，按金额对应的审批流程提交。\n3. 审批通过后创建采购订单，跟进交期。\n4. 到货后由仓库验收，财务按合同约定办理结算。",
  },
  {
    id: "doc-sales",
    name: "销售订单填写注意事项",
    libraryId: "business",
    type: "text",
    size: "文字记录",
    updatedAt: "2026-10-19 11:40",
    status: "ready",
    owner: "林晓",
    uploadedBy: "lin",
    keywords: ["销售", "开单", "订单", "客户", "价格"],
    content:
      "创建销售订单前，需要确认客户主体、商品规格、数量、单价、交货日期和发货仓库。价格以已审批报价为准，特殊折扣需要按业务规则审批。保存草稿不等于提交审批，提交后应核对系统返回的单据状态。",
  },
  {
    id: "doc-expense",
    name: "差旅与费用报销制度.pdf",
    libraryId: "people",
    type: "pdf",
    size: "1.6 MB",
    updatedAt: "2026-10-17 15:00",
    status: "ready",
    owner: "周宁",
    uploadedBy: "zhou",
    keywords: ["出差", "差旅", "报销", "发票", "费用"],
    content:
      "差旅报销需要准备以下材料：\n\n1. 已通过审批的出差申请。\n2. 交通、住宿等合规发票及付款凭证。\n3. 能对应出差日期和目的地的行程记录。\n4. 如有特殊费用，补充业务说明及审批记录。\n\n提交前请核对发票抬头、金额和费用归属，按公司审批流程提交。",
  },
  {
    id: "doc-leave",
    name: "员工请假办理说明.docx",
    libraryId: "people",
    type: "docx",
    size: "420 KB",
    updatedAt: "2026-10-16 09:10",
    status: "ready",
    owner: "周宁",
    uploadedBy: "zhou",
    keywords: ["请假", "年假", "考勤", "休假"],
    content:
      "请假前请查询可用假期余额，填写请假类型、起止时间及原因。安排好工作交接后提交主管审批，审批通过后由系统同步考勤。需要调整已批准的假期时，应提交变更申请。",
  },
  {
    id: "doc-private-lin",
    name: "网关巡检工作笔记",
    libraryId: "private-lin",
    type: "text",
    size: "文字记录",
    updatedAt: "2026-10-20 11:20",
    status: "ready",
    owner: "林晓",
    uploadedBy: "lin",
    keywords: ["巡检", "每周", "网关", "工作笔记"],
    content:
      "我的网关巡检安排：每周检查一次设备供电、网络连接与数据上报情况。\n\n巡检时先核对设备编号，记录异常指示灯和最近一次上报时间；发现异常后记录处理步骤，下次巡检复核结果。这是个人工作笔记，仅本人可查看和维护。",
  },
  {
    id: "doc-private-chen",
    name: "客户回访个人计划",
    libraryId: "private-chen",
    type: "text",
    size: "文字记录",
    updatedAt: "2026-10-20 10:40",
    status: "ready",
    owner: "陈亦",
    uploadedBy: "chen",
    keywords: ["松岚", "客户回访", "折扣37", "个人计划"],
    content:
      "本周个人回访计划：先联系松岚客户，确认试用进展与下一轮沟通时间。\n\n演示备注：松岚客户折扣37，用于记录我自己的跟进信息，正式报价仍需按业务审批。这份计划仅本人可查看和维护。",
  },
  {
    id: "doc-private-zhou",
    name: "入职跟进个人笔记",
    libraryId: "private-zhou",
    type: "text",
    size: "文字记录",
    updatedAt: "2026-10-20 09:50",
    status: "ready",
    owner: "周宁",
    uploadedBy: "zhou",
    keywords: ["入职", "跟进", "新人", "个人笔记"],
    content:
      "我的入职跟进清单：入职当天确认账号开通和设备领取，第三天询问系统使用情况，一周后收集培训反馈。\n\n每次沟通后记录待办并安排下次跟进时间。这是个人工作笔记，仅本人可查看和维护。",
  },
];

// Public knowledge is shared by signed-in users; private ownership has no
// administrator override. Unknown scopes and missing identities fail closed.
export function canAccessLibrary(library, userId) {
  if (!library || typeof userId !== "string" || !userId.trim()) return false;
  if (library.scope === "public") return true;
  return (
    library.scope === "private" &&
    typeof library.ownerId === "string" &&
    library.ownerId === userId
  );
}

export function accessibleLibraries(libraries, userId, scope = "all") {
  if (!["all", "public", "private"].includes(scope)) return [];
  return (libraries || []).filter(
    (library) =>
      canAccessLibrary(library, userId) &&
      (scope === "all" || library.scope === scope)
  );
}

export function canOperateDocument(doc, libraries, userId) {
  if (!doc?.libraryId) return false;
  return canAccessLibrary(
    (libraries || []).find((library) => library.id === doc.libraryId),
    userId
  );
}

function sourceFromDocument(doc, library) {
  return {
    documentId: doc.id,
    libraryId: library.id,
    scope: library.scope,
    ownerId: library.ownerId,
    title: `${library.scope === "public" ? `公有 · ${library.name}` : "私有 · 我的笔记"} · ${doc.name}`,
    text: doc.content,
  };
}

const copy = (value) => JSON.parse(JSON.stringify(value));
export function initialPreview() {
  const expense = demoDocuments.find((item) => item.id === "doc-expense");
  return {
    documents: copy(demoDocuments),
    conversations: [
      {
        id: "history-expense",
        ownerId: "lin",
        title: "出差报销需要哪些材料？",
        updatedAt: "今天",
        messages: [
          { id: "h1", role: "user", content: "出差报销需要哪些材料？" },
          {
            id: "h2",
            role: "assistant",
            content: expense.content,
            sources: [
              sourceFromDocument(
                expense,
                demoLibraries.find(
                  (library) => library.id === expense.libraryId
                )
              ),
            ],
          },
        ],
      },
    ],
  };
}

export function answerFromDocuments(
  question,
  documents = [],
  libraries = [],
  userId,
  scope = "all"
) {
  const query = String(question || "")
    .toLowerCase()
    .replace(/\s/g, "");
  const ignored = new Set([
    "什么",
    "怎么",
    "如何",
    "哪些",
    "一下",
    "帮我",
    "请问",
    "可以",
    "需要",
    "我们",
    "是否",
    "这个",
    "的是",
    "资料",
    "知识",
    "说明",
    "介绍",
    "一下",
    "进行",
  ]);
  const grams = [
    ...new Set(
      query
        .match(/[\u4e00-\u9fa5]{2,}/g)
        ?.flatMap((part) =>
          Array.from({ length: part.length - 1 }, (_, index) =>
            part.slice(index, index + 2)
          )
        ) || []
    ),
  ].filter((part) => !ignored.has(part));
  const allowedLibraries = accessibleLibraries(libraries, userId, scope);
  const allowed = new Map(
    allowedLibraries.map((library) => [library.id, library])
  );
  const matches = documents
    .filter(
      (doc) =>
        allowed.has(doc.libraryId) &&
        doc.status === "ready" &&
        doc.content?.trim()
    )
    .map((doc) => ({
      doc,
      score:
        (doc.keywords || []).reduce(
          (score, word) => score + (query.includes(word) ? 6 : 0),
          0
        ) +
        grams.reduce(
          (score, gram) =>
            score + ((doc.name + doc.content).includes(gram) ? 1 : 0),
          0
        ),
    }))
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  if (!matches.length)
    return {
      content:
        "当前可访问的演示资料中，暂时没有找到与这个问题直接相关的内容。\n\n你可以换一个更具体的关键词，或到「知识资料」补充相关文字记录后再提问。也可以先试试安装验收、采购审批、差旅报销等问题。",
      sources: [],
    };
  return {
    content: `根据相关资料，为你整理如下：\n\n${matches.map(({ doc }) => `### ${doc.name.replace(/\.(pdf|docx|xlsx)$/i, "")}\n\n${doc.content}`).join("\n\n")}`,
    sources: matches.map(({ doc }) =>
      sourceFromDocument(doc, allowed.get(doc.libraryId))
    ),
  };
}
