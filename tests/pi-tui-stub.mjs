// Stub de teste para @earendil-works/pi-tui: só o necessário para importar index.ts sem a UI real.
export class Text {
	constructor(text) {
		this.text = text;
	}
}
export class SelectList {
	constructor(items) {
		this.items = items;
	}
}
export const truncateToWidth = (s) => s;
export const visibleWidth = (s) => String(s).length;
