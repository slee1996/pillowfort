import { create } from "zustand";

export interface FormatStore {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  setColor: (color: string | null) => void;
  getStyle: () => { bold?: boolean; italic?: boolean; underline?: boolean; color?: string } | undefined;
}

export const useFormatStore = create<FormatStore>((set, get) => ({
  bold: false,
  italic: false,
  underline: false,
  color: null,

  toggleBold: () => set((s) => ({ bold: !s.bold })),
  toggleItalic: () => set((s) => ({ italic: !s.italic })),
  toggleUnderline: () => set((s) => ({ underline: !s.underline })),
  setColor: (color) => set({ color }),

  getStyle: () => {
    const { bold, italic, underline, color } = get();
    const style: Record<string, unknown> = {};
    if (bold) style.bold = true;
    if (italic) style.italic = true;
    if (underline) style.underline = true;
    if (color) style.color = color;
    return Object.keys(style).length ? (style as ReturnType<FormatStore["getStyle"]>) : undefined;
  },
}));
