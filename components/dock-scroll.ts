/** Route wheel input for the overlay, which is a sibling of the transcript.
 * Expanded questions own their wheel input even at an internal scroll boundary;
 * only the ordinary composer/collapsed dock still forwards to chat history.
 */
export function routeDockWheel(event: WheelEvent, root: HTMLElement, transcript: HTMLElement): void {
	if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
	const target = event.target instanceof Element ? event.target : null;
	const surface = target?.closest("[data-dock-surface]");
	for (let node = target; node; node = node === root ? null : node.parentElement) {
		if (!(node instanceof HTMLElement)) continue;
		const overflow = getComputedStyle(node).overflowY;
		if (overflow !== "auto" && overflow !== "scroll") continue;
		const max = node.scrollHeight - node.clientHeight;
		if (max < 2) continue;
		if (event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop < max - 0.5) return; // native scrolling
	}
	event.preventDefault();
	if (surface && root.contains(surface)) return; // never fold while reading/typing in this panel
	const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? transcript.clientHeight : 1;
	transcript.scrollTop += event.deltaY * unit;
}

/** Full form budget: surrounding dock chrome is NOT part of the question area. */
export function dockFormHeight(viewportHeight: number, blockHeight: number, shellHeight: number): number {
	return Math.max(0, viewportHeight - 32 - Math.max(0, blockHeight - shellHeight));
}
