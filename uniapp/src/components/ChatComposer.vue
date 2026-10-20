<template>
  <view
    :id="composerId"
    class="chat-composer"
    :class="{ 'chat-composer--compact': compact }"
  >
    <view v-if="error" class="chat-composer__error" role="alert">
      <wd-icon name="warning" size="15px" />
      <text class="chat-composer__error-text">{{ error }}</text>
      <wd-button
        type="icon"
        icon="close"
        aria-label="关闭提示"
        custom-style="width:28px;height:28px;min-width:28px;color:#b35442;"
        @click="emit('clear-error')"
      />
    </view>

    <view
      class="chat-composer__field"
      :class="{ 'is-focused': focused, 'is-disabled': disabled }"
    >
      <view class="composer-input">
        <wd-textarea
          :model-value="inputValue"
          :disabled="disabled"
          :placeholder="placeholder || '发送消息…'"
          :focus="requestFocus"
          :maxlength="20000"
          :auto-height="true"
          :fixed="true"
          :adjust-position="false"
          :hold-keyboard="true"
          :confirm-hold="true"
          :show-confirm-bar="false"
          :disable-default-padding="true"
          :ignore-composition-event="false"
          :confirm-type="confirmType"
          :no-border="true"
          custom-class="chat-composer__textarea"
          custom-textarea-class="chat-composer__native-input"
          placeholder-style="color:#969da9;font-size:15px;line-height:24px;"
          @update:model-value="onUpdate"
          @input="onInput"
          @focus="onFocus"
          @blur="onBlur"
          @confirm="onConfirm"
          @keyboardheightchange="onKeyboardHeight"
        />
      </view>

      <view class="chat-composer__toolbar">
        <view class="chat-composer__context">
          <wd-icon name="chat" size="14px" color="#8a92a0" />
          <text>{{ contextLabel || "团队知识问答" }}</text>
        </view>
        <view class="chat-composer__actions">
          <!-- #ifdef H5 -->
          <text class="chat-composer__keyboard-hint">Enter 发送</text>
          <!-- #endif -->
          <wd-button
            v-if="sending"
            type="primary"
            custom-class="composer-send chat-composer__stop"
            custom-style="width:36px;height:36px;min-width:36px;padding:0;border-radius:10px;"
            aria-label="停止生成"
            @click="emit('stop')"
          >
            <wd-icon name="stop" size="19px" color="#ffffff" />
          </wd-button>
          <wd-button
            v-else
            type="primary"
            :disabled="!canSend"
            custom-class="composer-send"
            custom-style="width:36px;height:36px;min-width:36px;padding:0;border-radius:10px;"
            aria-label="发送消息"
            @click="send()"
          >
            <wd-icon name="arrow-up" size="20px" color="#ffffff" />
          </wd-button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import {
  computed,
  getCurrentInstance,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

defineOptions({ options: { virtualHost: true, styleIsolation: "shared" } });

const props = defineProps({
  modelValue: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  sending: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
  contextLabel: { type: String, default: "" },
  error: { type: String, default: "" },
});
const emit = defineEmits([
  "update:modelValue",
  "send",
  "stop",
  "clear-error",
  "keyboard-height",
]);

const composerId = `chat-composer-${getCurrentInstance().uid}`;
const inputValue = ref(props.modelValue);
const focused = ref(false);
const requestFocus = ref(false);
const canSend = computed(
  () => !props.disabled && !props.sending && !!inputValue.value.trim()
);
let composing = false;
let confirmType = "send";
// #ifdef H5
// Native key events preserve Shift and IME state; uni-app's normalized ones do not.
confirmType = "return";
// #endif

function update(value) {
  if (typeof value !== "string") return;
  inputValue.value = value;
  emit("update:modelValue", value);
}

function onUpdate(value) {
  // #ifdef H5
  const field = nativeField();
  // uni-app delays its input events. The actual field is always the newest value.
  if (field) {
    update(field.value);
    return;
  }
  // #endif
  update(value);
}

function onInput(detail) {
  // #ifndef H5
  update(detail?.value);
  // #endif
}

function send(value) {
  // #ifdef H5
  if (typeof value !== "string") value = nativeField()?.value;
  // #endif
  if (typeof value === "string") update(value);
  if (!canSend.value || composing) return;
  emit("send", inputValue.value);
}

function onConfirm(detail) {
  // H5 uses the native keydown listener below to distinguish Enter from Shift+Enter.
  // #ifndef H5
  send(detail?.value);
  // #endif
}

function onFocus() {
  focused.value = true;
}

function onBlur() {
  focused.value = false;
  requestFocus.value = false;
  composing = false;
  // #ifndef H5
  emit("keyboard-height", 0);
  // #endif
}

function onKeyboardHeight(detail) {
  emit("keyboard-height", Math.max(0, Number(detail?.height) || 0));
}

async function focus() {
  if (props.disabled) return;
  requestFocus.value = false;
  await nextTick();
  requestFocus.value = true;
  // #ifdef H5
  nativeField()?.focus();
  // #endif
}

function blur() {
  requestFocus.value = false;
  focused.value = false;
  composing = false;
  // #ifdef H5
  nativeField()?.blur();
  // #endif
}

function clear() {
  update("");
  // #ifdef H5
  syncNativeValue("");
  // #endif
}

watch(
  () => props.modelValue,
  async (value) => {
    inputValue.value = value;
    // #ifdef H5
    await nextTick();
    if (value !== props.modelValue) return;
    syncNativeValue(value);
    // #endif
  }
);

// #ifdef H5
function nativeRoot() {
  return document.getElementById(composerId);
}

function nativeField() {
  return nativeRoot()?.querySelector("textarea");
}

function ownsField(target) {
  return target?.tagName === "TEXTAREA" && nativeRoot()?.contains(target);
}

function syncNativeValue(value) {
  const field = nativeField();
  if (!field || field.value === value) return;
  field.value = value;
  // Replace any pending throttled input with the cleared/new draft, retaining
  // this textarea's focus and selection instead of remounting the component.
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function captureInput(event) {
  if (ownsField(event.target)) update(event.target.value);
}

function captureComposition(event) {
  if (!ownsField(event.target)) return;
  composing = event.type !== "compositionend";
  if (!composing) update(event.target.value);
}

function captureKeydown(event) {
  if (!ownsField(event.target) || event.key !== "Enter") return;
  if (event.shiftKey || event.isComposing || composing || event.keyCode === 229)
    return;
  event.preventDefault();
  send(event.target.value);
}

function captureMousedown(event) {
  if (
    nativeRoot()?.contains(event.target) &&
    event.target?.closest(".composer-send")
  ) {
    // Mouse sends should keep the same text field focused.
    event.preventDefault();
  }
}

onMounted(() => {
  document.addEventListener("input", captureInput, true);
  document.addEventListener("compositionstart", captureComposition, true);
  document.addEventListener("compositionend", captureComposition, true);
  document.addEventListener("keydown", captureKeydown, true);
  document.addEventListener("mousedown", captureMousedown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("input", captureInput, true);
  document.removeEventListener("compositionstart", captureComposition, true);
  document.removeEventListener("compositionend", captureComposition, true);
  document.removeEventListener("keydown", captureKeydown, true);
  document.removeEventListener("mousedown", captureMousedown, true);
});
// #endif

defineExpose({ focus, blur, clear });
</script>

<style lang="scss">
.chat-composer {
  width: 100%;
  min-width: 0;
  --wot-textarea-fs: 15px;
  --wot-textarea-padding: 0px;

  &__field {
    padding: 14px 14px 10px;
    border: 1px solid #dfe3e8;
    border-radius: 14px;
    background: #ffffff;
    transition: border-color 0.16s;

    &.is-focused {
      border-color: #7da797;
    }

    &.is-disabled {
      background: #f9fafb;
    }
  }

  :deep(.chat-composer__textarea.wd-textarea) {
    padding: 0;
    background: transparent;
  }

  :deep(.wd-textarea__value) {
    background: transparent;
  }

  :deep(.chat-composer__native-input.wd-textarea__inner) {
    min-height: 48px;
    max-height: 144px;
    font-size: 15px;
    line-height: 24px;
    color: #293241;
  }

  &--compact :deep(.chat-composer__native-input.wd-textarea__inner) {
    min-height: 24px;
    max-height: 48px;
  }

  /* #ifdef H5 */
  :deep(.uni-textarea-wrapper) {
    min-height: inherit;
    max-height: inherit;
  }

  :deep(.uni-textarea-textarea) {
    overflow-y: auto !important;
  }
  /* #endif */

  &__toolbar,
  &__actions,
  &__context {
    display: flex;
    align-items: center;
  }

  &__toolbar {
    justify-content: space-between;
    gap: 12px;
    margin-top: 8px;
  }

  &__context {
    flex: 1;
    min-width: 0;
    gap: 6px;
    color: #8a92a0;
    font-size: 12px;

    text {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }

  &__actions {
    flex-shrink: 0;
    gap: 12px;
  }

  &__keyboard-hint {
    color: #a0a7b2;
    font-size: 11px;
  }

  &__error {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
    padding: 6px 8px 6px 12px;
    border-radius: 9px;
    background: #fff5f0;
    color: #b35442;
    font-size: 12px;
    line-height: 19px;
  }

  &__error-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
}

@media (max-width: 767px) {
  .chat-composer__keyboard-hint {
    display: none;
  }
}
</style>
