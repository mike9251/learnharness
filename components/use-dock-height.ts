"use client";

import { useLayoutEffect, useRef } from "react";

const px = (value: string) => Number.parseFloat(value) || 0;

/** --dock-max-h is the WHOLE expanded form's budget, not its question's.
 * Keep the measured controls outside the question scroller. If even those
 * controls cannot fit, let the bounded root scroll the whole form instead.
 */
export function useDockHeight(active: boolean, fallback: string) {
	const rootRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const budget = `var(--dock-max-h, ${fallback})`;

	useLayoutEffect(() => {
		const root = rootRef.current;
		const area = scrollRef.current;
		if (!active || !root || !area) return;
		const controls = Array.from(root.children).filter((child) => child !== area) as HTMLElement[];
		const measure = () => {
			const rootStyle = getComputedStyle(root);
			const areaStyle = getComputedStyle(area);
			const fixed = controls.reduce((height, control) => {
				const style = getComputedStyle(control);
				return height + control.getBoundingClientRect().height + px(style.marginTop) + px(style.marginBottom);
			}, px(rootStyle.paddingTop) + px(rootStyle.paddingBottom) + px(rootStyle.borderTopWidth) + px(rootStyle.borderBottomWidth));
			const areaChrome = px(areaStyle.paddingTop) + px(areaStyle.paddingBottom) + px(areaStyle.borderTopWidth) + px(areaStyle.borderBottomWidth);
			const available = Number.parseFloat(rootStyle.maxHeight);
			const prose = area.querySelector<HTMLElement>(".lh-prose") ?? area;
			const lineHeight = px(getComputedStyle(prose).lineHeight);
			// Leave room for at least one actual prose line, not a sliver of
			// text after padding. A zero-height question would be unreachable. In a
			// very short session, the root's overflow is the accessible fallback.
			// Keep the normal cap in CSS so inherited budget changes can grow the
			// area too (a pixel cap would prevent the root's observer firing).
			const wholeFormScroll = Number.isFinite(available) && available < fixed + areaChrome + lineHeight;
			area.style.maxHeight = wholeFormScroll ? "none" : `max(0px, calc(${budget} - ${fixed}px))`;
			// An overflow:auto area with overscroll:contain traps wheel events
			// even when it has no overflow. In fallback mode it must stop being
			// a scroll container so the root can scroll from anywhere over it.
			area.style.overflowY = wholeFormScroll ? "visible" : "";
			area.style.overscrollBehaviorY = wholeFormScroll ? "auto" : "";
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		for (const control of controls) observer.observe(control);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [active, budget]);

	return { rootRef, scrollRef, surfaceStyle: { maxHeight: budget } };
}

/** scrollIntoView also moves the transcript. Move only these dock-owned
 * scrollers, from the innermost question area to the short-window fallback.
 */
export function scrollWithinDock(target: HTMLElement, ...containers: (HTMLElement | null)[]) {
	for (const container of containers) {
		if (!container || container.scrollHeight <= container.clientHeight) continue;
		const bounds = container.getBoundingClientRect();
		const top = bounds.top + container.clientTop;
		const bottom = top + container.clientHeight;
		const row = target.getBoundingClientRect();
		if (row.top < top && row.bottom > bottom) continue;
		if (row.top < top) container.scrollTop += row.top - top;
		else if (row.bottom > bottom) container.scrollTop += row.bottom - bottom;
	}
}
