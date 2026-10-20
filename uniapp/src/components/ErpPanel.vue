<template>
  <view class="erp-panel">
    <view class="erp-panel__topbar">
      <view class="erp-panel__mode"
        ><view class="erp-panel__dot" /><text
          >演示模式 · 操作仅在本地模拟</text
        ></view
      >
      <wd-button
        type="text"
        size="small"
        custom-style="color:#61716a;font-size:12px;padding:0;"
        @click="showHistory = !showHistory"
      >
        <wd-icon name="history" size="15px" />
        <text class="erp-panel__history-label">最近操作</text>
      </wd-button>
    </view>

    <scroll-view
      class="erp-panel__scroll"
      scroll-y
      :scroll-into-view="scrollTarget"
      :scroll-with-animation="true"
    >
      <view class="erp-panel__content">
        <view v-if="showHistory" class="erp-history">
          <view class="erp-card-title"
            ><text>最近模拟操作</text
            ><text class="erp-caption">仅保留本次使用记录</text></view
          >
          <view v-if="!records.length" class="erp-history__empty"
            >还没有操作记录，试着查询一项库存吧。</view
          >
          <view
            v-for="record in records"
            :key="record.id"
            class="erp-history__row"
            @click="openRecord(record)"
          >
            <view class="erp-history__main"
              ><text class="erp-history__label">{{ record.label }}</text
              ><text class="erp-caption"
                >{{ record.time }} · {{ record.detail }}</text
              ></view
            >
            <text class="erp-history__open"
              >查看 <wd-icon name="arrow-right" size="12px"
            /></text>
          </view>
        </view>

        <view
          class="erp-welcome"
          :class="{ 'erp-welcome--compact': messages.length }"
        >
          <view class="erp-welcome__mark"
            ><wd-icon name="app" size="25px" color="#237b61"
          /></view>
          <text class="erp-welcome__eyebrow">ERP COPILOT</text>
          <text class="erp-welcome__title">把业务交给一句话</text>
          <text class="erp-welcome__description"
            >{{
              userName
            }}，告诉我你要查询或办理的业务。\n我会帮你整理信息，再由你确认操作。</text
          >
          <view class="erp-examples">
            <view
              v-for="example in examples"
              :key="example.type"
              class="erp-example"
              @click="submit(example.prompt)"
            >
              <view class="erp-example__icon"
                ><wd-icon :name="example.icon" size="19px" color="#237b61"
              /></view>
              <text class="erp-example__title">{{ example.title }}</text>
              <text class="erp-example__description">{{ example.label }}</text>
              <wd-icon
                name="arrow-right"
                size="13px"
                color="#829088"
                custom-class="erp-example__arrow"
              />
            </view>
          </view>
          <view v-if="!messages.length" class="erp-welcome__footnote"
            ><wd-icon name="secured" size="13px" /><text
              >查询直接展示结果，创建单据需确认后模拟执行</text
            ></view
          >
        </view>

        <view
          v-for="message in messages"
          :id="`erp-message-${message.id}`"
          :key="message.id"
          class="erp-message"
          :class="{ 'erp-message--user': message.role === 'user' }"
        >
          <view v-if="message.role === 'user'" class="erp-message__user"
            ><text selectable>{{ message.text }}</text></view
          >
          <template v-else>
            <view class="erp-message__identity"
              ><view class="erp-message__avatar"
                ><wd-icon name="app" size="13px" color="#237b61" /></view
              ><text>ERP 助手</text
              ><text class="erp-message__mock">本地演示</text></view
            >
            <text v-if="message.text" class="erp-message__text" selectable>{{
              message.text
            }}</text>

            <view v-if="message.kind === 'inventory'" class="erp-result-card">
              <view class="erp-card-title"
                ><text>商品库存</text
                ><text class="erp-status">模拟查询结果</text></view
              >
              <view class="erp-inventory-name"
                ><text>{{ message.product.name }}</text
                ><text class="erp-caption"
                  >{{ message.product.code }} · 单位：{{
                    message.product.unit
                  }}</text
                ></view
              >
              <view class="erp-table-row erp-table-row--head"
                ><text>仓库</text><text>账面库存</text
                ><text>可用库存</text></view
              >
              <view
                v-for="warehouse in message.product.warehouses"
                :key="warehouse.name"
                class="erp-table-row"
                ><text>{{ warehouse.name }}</text
                ><text>{{ warehouse.stock }}</text
                ><text class="erp-stock">{{ warehouse.available }}</text></view
              >
              <view class="erp-card-foot"
                ><text>可用库存合计</text
                ><text class="erp-stock"
                  >{{ availableTotal(message.product) }}
                  {{ message.product.unit }}</text
                ></view
              >
            </view>

            <view v-else-if="message.kind === 'orders'" class="erp-result-card">
              <view class="erp-card-title"
                ><text>销售订单</text
                ><text class="erp-status">模拟查询结果</text></view
              >
              <view
                v-for="order in message.orders"
                :key="order.number"
                class="erp-order-row"
              >
                <view class="erp-order-row__heading"
                  ><text class="erp-order-number">{{ order.number }}</text
                  ><text
                    class="erp-order-state"
                    :class="{
                      'erp-order-state--pending': order.status === '待发货',
                    }"
                    >{{ order.status }}</text
                  ></view
                >
                <text class="erp-order-customer">{{ order.customer }}</text>
                <text class="erp-caption"
                  >{{ order.product }} × {{ order.quantity }} ·
                  {{ order.date }}</text
                >
                <view class="erp-order-row__bottom"
                  ><text class="erp-caption">订单金额</text
                  ><text class="erp-order-amount"
                    >¥{{ formatMoney(order.amount) }}</text
                  ></view
                >
              </view>
            </view>

            <view
              v-else-if="message.kind === 'draft'"
              class="erp-result-card erp-draft"
            >
              <view class="erp-card-title"
                ><text>创建销售订单</text
                ><text class="erp-step">{{
                  draftStageLabel(message.stage)
                }}</text></view
              >
              <template v-if="message.stage === 'editing'">
                <text class="erp-form-intro"
                  >补全以下信息，下一步核对订单内容。</text
                >
                <view class="erp-form-grid">
                  <view class="erp-form-field"
                    ><text class="erp-form-label"
                      >客户名称 <text class="erp-required">*</text></text
                    ><input
                      v-model="message.form.customer"
                      class="erp-form-input"
                      placeholder="例如：华辰科技"
                      :maxlength="40"
                  /></view>
                  <view class="erp-form-field"
                    ><text class="erp-form-label"
                      >商品名称 <text class="erp-required">*</text></text
                    ><input
                      v-model="message.form.product"
                      class="erp-form-input"
                      placeholder="例如：智能网关"
                      :maxlength="40"
                  /></view>
                  <view class="erp-form-field"
                    ><text class="erp-form-label"
                      >数量 <text class="erp-required">*</text></text
                    ><input
                      v-model="message.form.quantity"
                      class="erp-form-input"
                      type="number"
                      placeholder="请输入正整数"
                      :maxlength="8"
                  /></view>
                  <view class="erp-form-field"
                    ><text class="erp-form-label"
                      >单价（元） <text class="erp-required">*</text></text
                    ><input
                      v-model="message.form.price"
                      class="erp-form-input"
                      type="digit"
                      placeholder="请输入大于 0 的金额"
                      :maxlength="12"
                  /></view>
                </view>
                <text class="erp-form-help"
                  >演示商品：智能网关、温湿度传感器、工业路由器</text
                >
                <view v-if="message.error" class="erp-form-error"
                  ><wd-icon name="warning" size="14px" /><text>{{
                    message.error
                  }}</text></view
                >
                <view class="erp-card-actions"
                  ><wd-button
                    type="primary"
                    size="small"
                    custom-style="background:#237b61;border-color:#237b61;border-radius:8px;"
                    @click="reviewDraft(message)"
                    >核对订单</wd-button
                  ><wd-button
                    type="text"
                    size="small"
                    custom-style="color:#75827b;"
                    @click="cancelDraft(message)"
                    >取消</wd-button
                  ></view
                >
              </template>
              <template
                v-else-if="
                  message.stage === 'confirming' ||
                  message.stage === 'executing'
                "
              >
                <view class="erp-confirm-notice"
                  ><wd-icon
                    name="info-circle"
                    size="16px"
                    color="#a07832"
                  /><text
                    >请确认以下内容。本次仅模拟创建，不会写入真实 ERP。</text
                  ></view
                >
                <view class="erp-summary"
                  ><view
                    ><text>客户</text
                    ><text>{{ message.form.customer }}</text></view
                  ><view
                    ><text>商品</text
                    ><text>{{ message.form.product }}</text></view
                  ><view
                    ><text>数量 / 单价</text
                    ><text
                      >{{ message.form.quantity }}
                      {{ productUnit(message.form.product) }} × ¥{{
                        formatMoney(message.form.price)
                      }}</text
                    ></view
                  ><view class="erp-summary__total"
                    ><text>订单总额</text
                    ><text
                      >¥{{
                        formatMoney(
                          Number(message.form.quantity) *
                            Number(message.form.price)
                        )
                      }}</text
                    ></view
                  ></view
                >
                <view class="erp-card-actions"
                  ><wd-button
                    type="primary"
                    size="small"
                    :loading="message.stage === 'executing'"
                    :disabled="message.stage === 'executing'"
                    custom-style="background:#237b61;border-color:#237b61;border-radius:8px;"
                    @click="executeDraft(message)"
                    >{{
                      message.stage === "executing"
                        ? "正在模拟"
                        : "确认模拟创建"
                    }}</wd-button
                  ><wd-button
                    type="text"
                    size="small"
                    :disabled="message.stage === 'executing'"
                    custom-style="color:#75827b;"
                    @click="editDraft(message)"
                    >修改</wd-button
                  ><wd-button
                    type="text"
                    size="small"
                    :disabled="message.stage === 'executing'"
                    custom-style="color:#75827b;"
                    @click="cancelDraft(message)"
                    >取消</wd-button
                  ></view
                >
              </template>
              <template v-else-if="message.stage === 'done'">
                <view class="erp-success"
                  ><view class="erp-success__icon"
                    ><wd-icon name="check" size="18px" color="#237b61" /></view
                  ><view
                    ><text class="erp-success__title">模拟完成</text
                    ><text class="erp-caption"
                      >已在本地生成演示订单，未写入真实 ERP</text
                    ></view
                  ></view
                >
                <view class="erp-summary"
                  ><view
                    ><text>演示单据号</text
                    ><text class="erp-order-number">{{
                      message.number
                    }}</text></view
                  ><view
                    ><text>客户 / 商品</text
                    ><text
                      >{{ message.form.customer }} ·
                      {{ message.form.product }}</text
                    ></view
                  ><view class="erp-summary__total"
                    ><text>订单总额</text
                    ><text
                      >¥{{
                        formatMoney(
                          Number(message.form.quantity) *
                            Number(message.form.price)
                        )
                      }}</text
                    ></view
                  ></view
                >
              </template>
              <view v-else class="erp-cancelled"
                ><wd-icon name="close-outline" size="16px" /><text
                  >已取消，本次没有创建任何单据。</text
                ></view
              >
            </view>
          </template>
        </view>
        <view id="erp-bottom" class="erp-scroll-bottom" />
      </view>
    </scroll-view>

    <view class="erp-composer">
      <view v-if="messages.length" class="erp-quick-intents"
        ><view
          v-for="example in examples"
          :key="example.type"
          class="erp-quick-intent"
          @click="submit(example.prompt)"
          ><wd-icon :name="example.icon" size="13px" /><text>{{
            example.title
          }}</text></view
        ></view
      >
      <view class="erp-composer__field">
        <wd-textarea
          v-model="input"
          placeholder="例如：给华辰科技创建 20 台智能网关的销售订单"
          :maxlength="500"
          :auto-height="true"
          :no-border="true"
          :show-confirm-bar="false"
          :adjust-position="false"
          custom-class="erp-composer__textarea"
          custom-textarea-class="erp-composer__native"
          @keyboardheightchange="onKeyboardHeight"
          @blur="emit('keyboard-height', 0)"
        />
        <view class="erp-composer__toolbar"
          ><text class="erp-composer__hint"
            >支持库存查询、订单查询、销售订单创建</text
          ><wd-button
            type="primary"
            :disabled="!input.trim()"
            custom-style="width:34px;min-width:34px;height:34px;padding:0;border-radius:9px;background:#237b61;border-color:#237b61;"
            aria-label="发送业务需求"
            @click="sendInput"
            ><wd-icon name="arrow-up" size="18px" color="#ffffff" /></wd-button
        ></view>
      </view>
      <text class="erp-composer__note"
        >所有数据均为示例 · 操作结果仅保留在当前页面</text
      >
    </view>
  </view>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref } from "vue";

defineOptions({ options: { virtualHost: true, styleIsolation: "shared" } });
defineProps({ userName: { type: String, default: "林晓" } });
const emit = defineEmits(["keyboard-height"]);

const input = ref("");
const messages = ref([]);
const records = ref([]);
const showHistory = ref(false);
const scrollTarget = ref("");
const timers = new Set();
let sequence = 0;
let orderSequence = 0;
let mounted = true;

function onKeyboardHeight(detail) {
  emit("keyboard-height", Math.max(0, Number(detail?.height) || 0));
}

const examples = [
  {
    type: "inventory",
    icon: "dashboard",
    title: "查询库存",
    label: "智能网关现在还有多少库存？",
    prompt: "查询智能网关的可用库存",
  },
  {
    type: "orders",
    icon: "list",
    title: "查询订单",
    label: "查看华辰科技的订单进度",
    prompt: "查询华辰科技的订单状态",
  },
  {
    type: "create",
    icon: "add",
    title: "创建销售订单",
    label: "用一句话开始开单",
    prompt: "给华辰科技创建20台智能网关的销售订单",
  },
];
const products = [
  {
    name: "智能网关",
    code: "GW-200",
    unit: "台",
    warehouses: [
      { name: "上海主仓", stock: 268, available: 236 },
      { name: "杭州备货仓", stock: 120, available: 108 },
    ],
  },
  {
    name: "温湿度传感器",
    code: "TH-100",
    unit: "个",
    warehouses: [
      { name: "上海主仓", stock: 580, available: 520 },
      { name: "杭州备货仓", stock: 240, available: 218 },
    ],
  },
  {
    name: "工业路由器",
    code: "RT-500",
    unit: "台",
    warehouses: [
      { name: "上海主仓", stock: 82, available: 66 },
      { name: "杭州备货仓", stock: 36, available: 30 },
    ],
  },
];
const demoOrders = [
  {
    number: "DEMO-SO-102001",
    customer: "华辰科技",
    product: "智能网关",
    quantity: 20,
    amount: 25600,
    status: "待发货",
    date: "2026-10-20",
  },
  {
    number: "DEMO-SO-101802",
    customer: "华辰科技",
    product: "温湿度传感器",
    quantity: 50,
    amount: 9900,
    status: "已完成",
    date: "2026-10-18",
  },
  {
    number: "DEMO-SO-101903",
    customer: "远山制造",
    product: "工业路由器",
    quantity: 10,
    amount: 26800,
    status: "待发货",
    date: "2026-10-19",
  },
];

function addMessage(message) {
  const entry = { id: ++sequence, ...message };
  messages.value.push(entry);
  scrollTo("erp-bottom");
  return messages.value[messages.value.length - 1];
}
async function scrollTo(target) {
  scrollTarget.value = "";
  await nextTick();
  if (mounted) scrollTarget.value = target;
}
function availableTotal(product) {
  return product.warehouses.reduce(
    (total, warehouse) => total + warehouse.available,
    0
  );
}
function formatMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : "0.00";
}
function productUnit(name) {
  return products.find((product) => product.name === name)?.unit || "件";
}
function draftStageLabel(stage) {
  return {
    editing: "1 / 2 · 补全信息",
    confirming: "2 / 2 · 待确认",
    executing: "模拟执行中",
    done: "模拟完成",
    cancelled: "已取消",
  }[stage];
}
function recordOperation(message, label, detail) {
  const now = new Date();
  records.value.unshift({
    id: message.id,
    label,
    detail,
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
  });
  records.value = records.value.slice(0, 8);
}
function openRecord(record) {
  showHistory.value = false;
  scrollTo(`erp-message-${record.id}`);
}
function sendInput() {
  const value = input.value.trim();
  if (!value) return;
  input.value = "";
  submit(value);
}
function submit(raw) {
  const value = String(raw).trim();
  if (!value) return;
  showHistory.value = false;
  addMessage({ role: "user", text: value });
  const activeDraft = messages.value.find(
    (message) =>
      message.kind === "draft" &&
      ["editing", "confirming", "executing"].includes(message.stage)
  );
  if (activeDraft) {
    addMessage({
      role: "assistant",
      kind: "text",
      text: "还有一笔销售订单正在处理，请先在上方订单卡片中补全、确认或取消，再发起下一项业务。",
    });
    return;
  }
  if (
    /删除|退款|付款|支付|审核|审批|作废|取消订单|修改订单|采购|生产订单|退货|出库|入库|调拨|收款|合同/.test(
      value
    )
  ) {
    unsupported("当前演示暂不支持这项操作。");
    return;
  }
  const hasCreateAction = /(创建|新建|开一|开张|下单)/.test(value);
  if (
    hasCreateAction &&
    /文档|页面|报告|接口|文件|用户|知识库|账号|功能|代码|邮件|短信|通知/.test(
      value
    )
  ) {
    unsupported("这项需求包含当前演示范围之外的对象或动作。");
    return;
  }
  if (
    hasCreateAction &&
    /不要|不必|别|停止|怎么|如何|方法|教程|流程|能否|能不能|可以吗|需要什么/.test(
      value
    )
  ) {
    unsupported("这句话包含操作说明、询问或否定意图，我不会直接生成订单草稿。");
    return;
  }
  const isGenericOrderRequest =
    /^(?:帮我|请|我要|我想)?\s*(?:创建|新建)(?:一张|一笔|一个)?\s*订单[。！!]?\s*$/.test(
      value
    );
  if (
    hasCreateAction &&
    (/销售订单|销售单/.test(value) || isGenericOrderRequest)
  ) {
    createDraft(value);
    return;
  }
  const isQuery = /查|看|多少|状态|进度|有哪些|列出/.test(value);
  if (isQuery && /库存|存货/.test(value)) {
    const found = products.filter((product) => value.includes(product.name));
    if (found.length !== 1) {
      unsupported(
        found.length > 1
          ? "请一次指定一种商品查询。"
          : "请说明要查哪种商品的库存。"
      );
      return;
    }
    const message = addMessage({
      role: "assistant",
      kind: "inventory",
      text: `查到了${found[0].name}的示例库存，以下为两个仓库的可用数量。`,
      product: found[0],
    });
    recordOperation(message, `查询${found[0].name}库存`, "模拟查询完成");
    return;
  }
  if (isQuery && /订单/.test(value)) {
    const number = value.match(/DEMO-(?:SO|NEW)-\d+/i)?.[0]?.toUpperCase();
    const customer = ["华辰科技", "远山制造"].find((name) =>
      value.includes(name)
    );
    const allOrders = [...createdOrders(), ...demoOrders];
    if (!number && !customer) {
      unsupported(
        "请提供客户名称（华辰科技、远山制造）或 DEMO 开头的演示单据号。"
      );
      return;
    }
    const orders = allOrders.filter((order) =>
      number ? order.number === number : order.customer === customer
    );
    if (!orders.length) {
      addMessage({
        role: "assistant",
        kind: "text",
        text: "没有找到匹配的演示订单。你可以试试“查询华辰科技的订单状态”。",
      });
      return;
    }
    const message = addMessage({
      role: "assistant",
      kind: "orders",
      text: `找到 ${orders.length} 笔演示订单，状态如下。`,
      orders,
    });
    recordOperation(
      message,
      number ? "查询演示订单" : `查询${customer}订单`,
      `${orders.length} 笔模拟结果`
    );
    return;
  }
  unsupported("我还不能确定你想办理哪项业务。");
}
function unsupported(prefix) {
  addMessage({
    role: "assistant",
    kind: "text",
    text: `${prefix}\n目前支持：查询库存、按客户或演示单号查询订单、创建销售订单。演示商品有智能网关、温湿度传感器和工业路由器，也可以点击上方示例体验。`,
  });
}
function createDraft(value) {
  const namedProducts = products.filter((product) =>
    value.includes(product.name)
  );
  // Capture the whole numeric token so -20, .5 or 1e3 cannot silently become 20, 5 or 3.
  const quantityMatches = [
    ...value.matchAll(
      /(?:^|[^\d.,eE+\-])([+-]?(?:\d[\d,.]*(?:[eE][+-]?\d+)?|\.\d+)|负(?:\d[\d,.]*|\.\d+))\s*(?:台|个|件|套)/g
    ),
  ];
  const quantityMatch = quantityMatches[0];
  const priceMatch = value.match(
    /(?:单价|每台|每个|每件)\s*(?:为|是|[:：])?\s*[¥￥]?\s*([+-]?(?:\d[\d,.]*(?:[eE][+-]?\d+)?|\.\d+)|负(?:\d[\d,.]*|\.\d+))/
  );
  const customerMatch = value.match(
    /(?:给|为)\s*(.+?)\s*(?:创建|新建|开一|开张|下单)/
  );
  const namedCustomers = ["华辰科技", "远山制造", "启明贸易"].filter((name) =>
    value.includes(name)
  );
  const knownCustomer = namedCustomers[0];
  if (
    namedProducts.length > 1 ||
    namedCustomers.length > 1 ||
    quantityMatches.length > 1
  ) {
    unsupported(
      "当前演示一次支持一位客户、一种商品和一个数量，请分别发起订单。"
    );
    return;
  }
  addMessage({
    role: "assistant",
    kind: "draft",
    stage: "editing",
    text: "已为你整理销售订单草稿。请补全单价并核对信息，确认后再模拟创建。",
    form: {
      customer: knownCustomer || customerMatch?.[1]?.trim() || "",
      product: namedProducts[0]?.name || "",
      quantity: normalizeNumericToken(quantityMatch?.[1] || ""),
      price: normalizeNumericToken(priceMatch?.[1] || ""),
    },
    error: "",
  });
}
function normalizeNumericToken(value) {
  const token = value.replace(/^负/, "-");
  return /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)
    ? token.replace(/,/g, "")
    : token;
}
function validateDraft(message) {
  const form = message.form;
  form.customer = form.customer.trim();
  form.product = form.product.trim();
  if (
    !form.customer ||
    !form.product ||
    !String(form.quantity).trim() ||
    !String(form.price).trim()
  )
    return "请填写客户、商品、数量和单价。";
  if (!products.some((product) => product.name === form.product))
    return "请选择演示商品：智能网关、温湿度传感器或工业路由器。";
  if (
    !/^\d+$/.test(String(form.quantity)) ||
    Number(form.quantity) < 1 ||
    Number(form.quantity) > 1000000 ||
    !Number.isSafeInteger(Number(form.quantity))
  )
    return "数量需要是 1 至 1,000,000 的整数。";
  if (
    !/^\d+(?:\.\d{1,2})?$/.test(String(form.price)) ||
    !Number.isFinite(Number(form.price)) ||
    Number(form.price) <= 0
  )
    return "单价需要大于 0，最多保留两位小数。";
  if (
    !Number.isFinite(Number(form.price) * Number(form.quantity)) ||
    Number(form.price) * Number(form.quantity) > 1000000000
  )
    return "演示订单总额最多为 10 亿元，请调整数量或单价。";
  return "";
}
function reviewDraft(message) {
  if (message.stage !== "editing") return;
  message.error = validateDraft(message);
  if (message.error) return;
  message.stage = "confirming";
  scrollTo(`erp-message-${message.id}`);
}
function editDraft(message) {
  if (message.stage === "confirming") message.stage = "editing";
}
function cancelDraft(message) {
  if (!["editing", "confirming"].includes(message.stage)) return;
  message.stage = "cancelled";
  message.error = "";
}
function executeDraft(message) {
  if (message.stage !== "confirming") return;
  const error = validateDraft(message);
  if (error) {
    message.error = error;
    message.stage = "editing";
    return;
  }
  message.stage = "executing";
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (!mounted || message.stage !== "executing") return;
    message.number = `DEMO-NEW-${String(++orderSequence).padStart(4, "0")}`;
    message.stage = "done";
    recordOperation(message, "创建销售订单", `${message.number} · 模拟完成`);
    scrollTo(`erp-message-${message.id}`);
  }, 650);
  timers.add(timer);
}
function createdOrders() {
  return messages.value
    .filter((message) => message.kind === "draft" && message.stage === "done")
    .map((message) => ({
      number: message.number,
      customer: message.form.customer,
      product: message.form.product,
      quantity: Number(message.form.quantity),
      amount: Number(message.form.quantity) * Number(message.form.price),
      status: "待发货",
      date: "本次模拟",
    }));
}

onBeforeUnmount(() => {
  mounted = false;
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
});
</script>

<style lang="scss" scoped>
.erp-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: #f6f8fa;
  color: #25342e;
  --wot-color-theme: #237b61;
}
.erp-panel__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  padding: 14px 30px;
  border-bottom: 1px solid #e5ebe7;
  background: #fff;
}
.erp-panel__mode {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: #728078;
}
.erp-panel__dot {
  width: 6px;
  height: 6px;
  background: #5d9a7e;
  border-radius: 50%;
}
.erp-panel__history-label {
  margin-left: 5px;
}
.erp-panel__scroll {
  flex: 1;
  min-height: 0;
  height: 0;
}
.erp-panel__content {
  max-width: 850px;
  margin: 0 auto;
  padding: 0 32px;
  box-sizing: border-box;
}
.erp-welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 48px 0 34px;
}
.erp-welcome__mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: 15px;
  border: 1px solid #dce9e1;
  border-radius: 18px;
  background: #eaf3ed;
}
.erp-welcome__eyebrow {
  color: #729084;
  letter-spacing: 2.2px;
  font-size: 10px;
  font-weight: 600;
}
.erp-welcome__title {
  margin-top: 9px;
  color: #25342e;
  font-size: 29px;
  letter-spacing: 0.3px;
  font-weight: 600;
  line-height: 1.5;
}
.erp-welcome__description {
  margin-top: 13px;
  color: #829087;
  font-size: 13px;
  line-height: 1.9;
  white-space: pre-line;
}
.erp-examples {
  display: flex;
  gap: 12px;
  width: 100%;
  margin-top: 31px;
  text-align: left;
}
.erp-example {
  position: relative;
  flex: 1;
  min-width: 0;
  padding: 20px 15px 18px;
  background: #fff;
  border: 1px solid #e5ebe7;
  border-radius: 13px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.erp-example:hover {
  border-color: #8fb6a5;
  box-shadow: 0 3px 12px #25342e08;
}
.erp-example__icon {
  margin-bottom: 14px;
}
.erp-example__title {
  display: block;
  color: #34483d;
  font-size: 14px;
  font-weight: 600;
}
.erp-example__description {
  display: block;
  margin-top: 8px;
  color: #8b968f;
  font-size: 11px;
  line-height: 1.65;
}
.erp-example :deep(.erp-example__arrow) {
  position: absolute;
  right: 14px;
  top: 23px;
}
.erp-welcome__footnote {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 22px;
  color: #9aa59e;
  font-size: 10px;
}
.erp-welcome--compact {
  align-items: flex-start;
  padding: 24px 0 25px;
  text-align: left;
}
.erp-welcome--compact .erp-welcome__mark,
.erp-welcome--compact .erp-welcome__eyebrow,
.erp-welcome--compact .erp-welcome__description,
.erp-welcome--compact .erp-examples {
  display: none;
}
.erp-welcome--compact .erp-welcome__title {
  margin: 0;
  font-size: 19px;
}
.erp-message {
  margin-bottom: 24px;
}
.erp-message--user {
  display: flex;
  justify-content: flex-end;
}
.erp-message__user {
  max-width: 82%;
  padding: 12px 16px;
  background: #e8f0eb;
  border-radius: 13px 3px 13px 13px;
  font-size: 13px;
  line-height: 1.8;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.erp-message__identity {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 12px;
  color: #4b6255;
  font-size: 12px;
  font-weight: 600;
}
.erp-message__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  background: #e6efe9;
}
.erp-message__mock {
  padding: 2px 5px;
  border: 1px solid #e1e8e3;
  border-radius: 4px;
  color: #8d9a92;
  font-size: 9px;
  font-weight: 400;
}
.erp-message__text {
  display: block;
  color: #53655b;
  font-size: 13px;
  line-height: 1.9;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.erp-result-card {
  margin-top: 13px;
  padding: 19px 20px 0;
  border: 1px solid #e5ebe7;
  border-radius: 13px;
  background: #fff;
  overflow: hidden;
}
.erp-card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.6;
}
.erp-caption {
  color: #93a096;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.7;
}
.erp-status {
  padding: 3px 7px;
  border-radius: 5px;
  background: #f0f5f1;
  color: #6e8b7b;
  font-size: 10px;
  font-weight: 400;
}
.erp-inventory-name {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 21px 0 16px;
  font-size: 13px;
}
.erp-table-row {
  display: flex;
  align-items: center;
  padding: 13px 0;
  border-bottom: 1px solid #eef1ee;
  font-size: 12px;
}
.erp-table-row > text {
  flex: 1;
  min-width: 0;
  text-align: right;
}
.erp-table-row > text:first-child {
  flex: 1.4;
  text-align: left;
}
.erp-table-row--head {
  padding: 10px 0;
  color: #8e9b92;
  font-size: 11px;
}
.erp-stock {
  color: #237b61;
  font-weight: 600;
}
.erp-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 0;
  color: #8b988f;
  font-size: 11px;
}
.erp-order-row {
  padding: 18px 0;
  border-bottom: 1px solid #eef1ee;
}
.erp-order-row:last-child {
  border: 0;
}
.erp-order-row__heading,
.erp-order-row__bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.erp-order-number {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.erp-order-state {
  padding: 3px 7px;
  background: #edf5f0;
  border-radius: 5px;
  color: #5b9878;
  font-size: 10px;
}
.erp-order-state--pending {
  background: #fcf5e8;
  color: #b18b42;
}
.erp-order-customer {
  display: block;
  margin: 12px 0 5px;
  font-size: 12px;
}
.erp-order-row__bottom {
  margin-top: 12px;
}
.erp-order-amount {
  font-size: 13px;
  font-weight: 600;
}
.erp-step {
  color: #809286;
  font-size: 10px;
  font-weight: 400;
}
.erp-form-intro {
  display: block;
  margin: 12px 0 19px;
  color: #8d9991;
  font-size: 12px;
}
.erp-form-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 17px 20px;
}
.erp-form-field {
  width: calc(50% - 10px);
  min-width: 0;
}
.erp-form-label {
  display: block;
  margin-bottom: 8px;
  color: #63766a;
  font-size: 12px;
}
.erp-required {
  color: #c38f66;
}
.erp-form-input {
  width: 100%;
  height: 38px;
  padding: 0 11px;
  border: 1px solid #e0e7e1;
  border-radius: 7px;
  box-sizing: border-box;
  color: #354b3e;
  font-size: 12px;
  background: #fcfdfc;
}
.erp-form-input :deep(input) {
  font-size: 12px;
}
.erp-form-help {
  display: block;
  margin: 13px 0 0;
  color: #9aa69e;
  font-size: 10px;
  line-height: 1.7;
}
.erp-form-error {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin-top: 12px;
  padding: 9px 10px;
  border-radius: 7px;
  background: #fff3ec;
  color: #b56e4c;
  font-size: 11px;
  line-height: 1.7;
}
.erp-card-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 17px;
  padding: 15px 0;
  border-top: 1px solid #eef1ee;
}
.erp-confirm-notice {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 17px;
  padding: 10px;
  border-radius: 7px;
  background: #fcf8ee;
  color: #a08b62;
  font-size: 11px;
  line-height: 1.8;
}
.erp-summary {
  padding: 8px 0 0;
}
.erp-summary > view {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 11px 0;
  color: #88968c;
  font-size: 12px;
  line-height: 1.6;
}
.erp-summary > view > text:last-child {
  max-width: 74%;
  text-align: right;
  color: #3b5042;
  overflow-wrap: anywhere;
}
.erp-summary > .erp-summary__total {
  padding: 14px 0;
  border-top: 1px solid #eef1ee;
}
.erp-summary__total > text:last-child {
  font-size: 16px;
  font-weight: 600;
}
.erp-success {
  display: flex;
  align-items: center;
  gap: 11px;
  margin: 21px 0 13px;
}
.erp-success__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  background: #eaf4ee;
  border-radius: 50%;
}
.erp-success__title {
  display: block;
  margin-bottom: 5px;
  color: #237b61;
  font-size: 14px;
  font-weight: 600;
}
.erp-cancelled {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 23px 0;
  color: #93a097;
  font-size: 12px;
}
.erp-history {
  margin-top: 22px;
  padding: 17px 19px 4px;
  border: 1px solid #e5ebe7;
  border-radius: 13px;
  background: #fff;
}
.erp-history__empty {
  padding: 22px 0;
  color: #96a197;
  font-size: 12px;
}
.erp-history__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0;
  border-top: 1px solid #eef1ee;
  cursor: pointer;
}
.erp-history__row:nth-child(2) {
  margin-top: 13px;
}
.erp-history__main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.erp-history__label {
  color: #5a6f61;
  font-size: 12px;
}
.erp-history__open {
  flex-shrink: 0;
  color: #7d9c89;
  font-size: 11px;
}
.erp-scroll-bottom {
  height: 8px;
}
.erp-composer {
  flex-shrink: 0;
  width: 100%;
  max-width: 850px;
  box-sizing: border-box;
  margin: 0 auto;
  padding: 8px 32px 15px;
}
.erp-composer__field {
  padding: 13px 14px 10px;
  border: 1px solid #dfe7e1;
  border-radius: 13px;
  background: #fff;
}
.erp-composer :deep(.erp-composer__textarea.wd-textarea) {
  padding: 0;
  background: transparent;
  --wot-textarea-fs: 13px;
}
.erp-composer :deep(.erp-composer__native.wd-textarea__inner) {
  min-height: 42px;
  max-height: 90px;
  font-size: 13px;
  line-height: 22px;
}
.erp-composer :deep(.uni-textarea-wrapper) {
  max-height: 90px;
}
.erp-composer :deep(.uni-textarea-textarea) {
  overflow-y: auto !important;
}
.erp-composer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 5px;
}
.erp-composer__hint {
  color: #a2aca6;
  font-size: 10px;
}
.erp-composer__note {
  display: block;
  margin-top: 9px;
  text-align: center;
  color: #acb5ae;
  font-size: 9px;
}
.erp-quick-intents {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.erp-quick-intent {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  background: #fff;
  border: 1px solid #e5ebe7;
  border-radius: 7px;
  color: #71897a;
  font-size: 10px;
  cursor: pointer;
}
@media (max-width: 767px) {
  .erp-panel__topbar {
    padding: 10px 17px;
  }
  .erp-panel__mode {
    font-size: 10px;
    gap: 5px;
  }
  .erp-panel__content {
    padding: 0 17px;
  }
  .erp-welcome {
    padding: 30px 0 25px;
  }
  .erp-welcome__mark {
    width: 48px;
    height: 48px;
    border-radius: 15px;
  }
  .erp-welcome__title {
    font-size: 24px;
  }
  .erp-welcome__description {
    font-size: 12px;
  }
  .erp-examples {
    flex-direction: column;
    gap: 9px;
    margin-top: 23px;
  }
  .erp-example {
    padding: 14px 35px 14px 50px;
  }
  .erp-example__icon {
    position: absolute;
    left: 16px;
    top: 20px;
    margin: 0;
  }
  .erp-example__title {
    font-size: 13px;
  }
  .erp-example__description {
    margin-top: 4px;
  }
  .erp-welcome__footnote {
    font-size: 9px;
  }
  .erp-welcome--compact {
    padding: 22px 0;
  }
  .erp-result-card {
    padding: 16px 14px 0;
  }
  .erp-card-title {
    font-size: 13px;
  }
  .erp-form-grid {
    gap: 15px;
  }
  .erp-form-field {
    width: calc(50% - 8px);
  }
  .erp-message__user {
    max-width: 90%;
  }
  .erp-message__text {
    font-size: 12px;
  }
  .erp-summary > view {
    font-size: 11px;
    gap: 10px;
  }
  .erp-composer {
    padding: 8px 17px calc(10px + env(safe-area-inset-bottom));
  }
  .erp-composer__hint {
    max-width: calc(100% - 45px);
    font-size: 9px;
    line-height: 1.6;
  }
  .erp-quick-intents {
    gap: 6px;
  }
  .erp-quick-intent {
    padding: 6px 8px;
    font-size: 9px;
  }
  .erp-history {
    padding: 15px 13px 3px;
  }
  .erp-history .erp-card-title {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
}
@media (max-width: 360px) {
  .erp-form-field {
    width: 100%;
  }
  .erp-card-actions {
    gap: 4px;
  }
}
</style>
