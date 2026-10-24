import {
  lazy,
  Suspense,
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
} from "react";
import {
  ChatCircle,
  Books,
  Users,
  Gear,
  Buildings,
  Plus,
  CaretRight,
  PaperPlaneRight,
  FileText,
  UploadSimple,
  TextT,
  MagnifyingGlass,
  X,
  Check,
  LockSimple,
  Globe,
  PencilSimple,
  Trash,
  SignOut,
  Sparkle,
  ArrowClockwise,
  Info,
  ClockCounterClockwise,
  Copy,
  ShieldCheck,
  List,
} from "@phosphor-icons/react";
import BaseModal, {
  ModalBody,
  ModalHeader,
  ModalPrimaryButton,
  ModalSecondaryButton,
  ModalInput,
  ModalTextarea,
  ModalLabel,
  ModalHint,
} from "@/components/lib/Modal";

const MarkdownRenderer = lazy(() => import("@/components/lib/Markdown"));
export function Markdown({ children }) {
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
      <MarkdownRenderer>{children}</MarkdownRenderer>
    </Suspense>
  );
}

const icons = {
  chat: ChatCircle,
  books: Books,
  users: Users,
  settings: Gear,
  building: Buildings,
  plus: Plus,
  arrow: CaretRight,
  send: PaperPlaneRight,
  file: FileText,
  upload: UploadSimple,
  text: TextT,
  search: MagnifyingGlass,
  close: X,
  check: Check,
  lock: LockSimple,
  globe: Globe,
  edit: PencilSimple,
  trash: Trash,
  logout: SignOut,
  spark: Sparkle,
  refresh: ArrowClockwise,
  info: Info,
  history: ClockCounterClockwise,
  copy: Copy,
  shield: ShieldCheck,
  menu: List,
};

export function Icon({ name, size = 20, ...props }) {
  const Component = icons[name] || FileText;
  return (
    <Component size={size} className="shrink-0" aria-hidden="true" {...props} />
  );
}

export function Button({
  children,
  icon,
  variant = "primary",
  busy,
  className = "",
  ...props
}) {
  const Component =
    variant === "primary" ? ModalPrimaryButton : ModalSecondaryButton;
  return (
    <Component
      {...props}
      disabled={props.disabled || busy}
      className={`gap-x-2 whitespace-nowrap ${className}`}
    >
      {busy ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        icon && <Icon name={icon} size={17} />
      )}
      {children}
    </Component>
  );
}

export function Notice({ children, type = "error", onClose }) {
  if (!children) return null;
  return (
    <div
      className={`mb-4 flex items-start gap-3 rounded-lg border p-3 text-sm ${type === "success" ? "border-green-500/30 bg-green-500/10 text-green-400 light:text-green-700" : "border-red-500/30 bg-red-500/10 text-red-400 light:text-red-700"}`}
      role={type === "error" ? "alert" : "status"}
    >
      <Icon name={type === "success" ? "check" : "info"} size={18} />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onClose && (
        <button
          type="button"
          className="rounded p-0.5 hover:bg-theme-action-menu-item-hover"
          onClick={onClose}
          aria-label="关闭提示"
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

export function Empty({ icon = "books", title, children, action }) {
  return (
    <div className="flex flex-col items-center gap-y-4 px-6 py-16 text-center text-theme-text-secondary">
      <Icon name={icon} size={34} />
      <h3 className="text-base font-semibold text-theme-text-primary">
        {title}
      </h3>
      <p className="max-w-md text-sm leading-relaxed">{children}</p>
      {action}
    </div>
  );
}

export function Modal({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const trap = (event) => {
      if (event.key !== "Tab") return;
      const items = [
        ...node.querySelectorAll(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]'
        ),
      ];
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1).focus();
      }
      if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", trap);
    node.querySelector("input,textarea,select,button")?.focus();
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, []);
  return (
    <BaseModal isOpen onClose={onClose} size={wide ? "xl" : "md"}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex flex-col gap-y-5 text-theme-text-primary"
      >
        <ModalHeader title={title} subtitle={subtitle} onClose={onClose} />
        <ModalBody>{children}</ModalBody>
      </div>
    </BaseModal>
  );
}

export function Field({ label, hint, children }) {
  const id = useId();
  const child =
    Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  if (
    isValidElement(child) &&
    ["input", "textarea", "select"].includes(child.type)
  ) {
    const Component = child.type === "textarea" ? ModalTextarea : ModalInput;
    return (
      <div className="mb-5">
        <Component
          {...child.props}
          {...(child.type === "select" ? { as: "select" } : {})}
          id={child.props.id || id}
          label={label}
          hint={hint}
        />
      </div>
    );
  }
  return (
    <div className="mb-5 flex w-full flex-col gap-y-1.5">
      <ModalLabel htmlFor={id}>{label}</ModalLabel>
      {children}
      {hint && <ModalHint>{hint}</ModalHint>}
    </div>
  );
}

export function Scope({ value }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-theme-sidebar-item-default px-2 py-1 text-xs text-theme-text-secondary">
      <Icon name={value === "private" ? "lock" : "globe"} size={13} />
      {value === "private" ? "私有" : "公有"}
    </span>
  );
}

export function Status({ value }) {
  const labels = {
    processing: "处理中",
    ready: "可检索",
    failed: "处理失败",
    active: "正常",
    disabled: "已停用",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs ${["failed", "disabled"].includes(value) ? "text-red-400 light:text-red-700" : value === "processing" ? "text-amber-400 light:text-amber-700" : "text-green-400 light:text-green-700"}`}
    >
      <i className="h-1.5 w-1.5 rounded-full bg-current" />
      {labels[value] || value}
    </span>
  );
}

export function dateLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function DocumentViewer({ document: doc, onClose }) {
  return (
    <Modal
      title={doc.title || "资料详情"}
      subtitle="查看您有权访问的当前资料"
      onClose={onClose}
      wide
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-theme-sidebar-border pb-4 text-xs text-theme-text-secondary">
        <Scope value={doc.visibility} />
        <Status value={doc.status} />
        <span>更新于 {dateLabel(doc.updatedAt)}</span>
      </div>
      <div className="pt-4">
        <Markdown>{doc.content || "此文件未提供文本预览。"}</Markdown>
      </div>
    </Modal>
  );
}
