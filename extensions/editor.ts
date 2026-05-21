/**
 * Custom editor with a wider autocomplete column.
 *
 * pi-tui's slash-command layout caps the left column at 32 chars, which
 * truncates long IDs like `google-ai-studio/gemini-3.1-flash-lite-preview`
 * in the `/model` picker. Note: pi only applies that layout when the
 * autocomplete *prefix* starts with `/` — for `/model googl`, the prefix
 * is `googl`, so the cap never applies and the column falls back to the
 * 32-char default. Either way we get truncation.
 *
 * This subclass overrides `createAutocompleteList` to always pass a wider
 * `maxPrimaryColumnWidth`. `SelectList` still sizes the column to the
 * widest visible item, so short lists stay narrow.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type EditorOptions,
	type EditorTheme,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
} from "@earendil-works/pi-tui";

const WIDE_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 64,
};

// pi-tui marks `createAutocompleteList` as private, so TS rejects both the
// override (TS2415) and treats the method as unused (TS6133). Suppress both;
// JS dispatch still finds the override on the prototype at runtime.
// @ts-expect-error TS2415 — overriding base-class private method
class WideAutocompleteEditor extends CustomEditor {
	private editorTheme: EditorTheme;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		options?: EditorOptions,
	) {
		super(tui, theme, keybindings, options);
		this.editorTheme = theme;
	}

	// @ts-ignore TS6133 (only fires under noUnusedLocals) — called by the base class via prototype dispatch
	private createAutocompleteList(_prefix: string, items: SelectItem[]): SelectList {
		return new SelectList(
			items,
			this.getAutocompleteMaxVisible(),
			this.editorTheme.selectList,
			WIDE_LAYOUT,
		);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new WideAutocompleteEditor(tui, theme, keybindings),
		);
	});
}
