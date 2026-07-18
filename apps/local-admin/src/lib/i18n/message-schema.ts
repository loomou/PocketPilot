import type { zhCN } from "@/lib/i18n/messages/zh-cn";

type WidenMessageShape<T> = T extends (...args: infer Arguments) => string
  ? (...args: Arguments) => string
  : T extends string
    ? string
    : T extends object
      ? { [Key in keyof T]: WidenMessageShape<T[Key]> }
      : T;

export type TranslationMessages = WidenMessageShape<typeof zhCN>;
