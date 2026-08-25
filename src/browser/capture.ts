import type { Page } from "playwright";
import type { BoundingBox, BrowserObservation, InteractiveElementSnapshot } from "./types.js";

function intersectionRatio(target: BoundingBox | null, blocker: BoundingBox | null): number {
  if (!target || !blocker || target.width <= 0 || target.height <= 0) return 0;
  const left = Math.max(target.x, blocker.x);
  const top = Math.max(target.y, blocker.y);
  const right = Math.min(target.x + target.width, blocker.x + blocker.width);
  const bottom = Math.min(target.y + target.height, blocker.y + blocker.height);
  if (right <= left || bottom <= top) return 0;
  return ((right - left) * (bottom - top)) / (target.width * target.height);
}

export async function getWorkflowState(page: Page): Promise<BrowserObservation["workflowState"]> {
  return page.locator("body").getAttribute("data-workflow-state").then((value) => (value ?? "UNKNOWN") as BrowserObservation["workflowState"]);
}

export async function captureObservation(page: Page, targetId: string | null): Promise<BrowserObservation> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const title = await page.title();
  const pageText = (await page.locator("body").innerText()).slice(0, 12000);
  let accessibility = "";
  try {
    accessibility = (await page.locator("body").ariaSnapshot()).slice(0, 12000);
  } catch {
    accessibility = pageText;
  }

  const interactiveElements = await page.locator("a,button,input,select,textarea,[role=button]").evaluateAll((nodes) =>
    nodes.slice(0, 100).map((node) => {
      const element = node as HTMLElement;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      let ancestor: HTMLElement | null = element;
      let fixedAncestor = false;
      while (ancestor) {
        if (window.getComputedStyle(ancestor).position === "fixed") {
          fixedAncestor = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        text: (element.innerText || (element as HTMLInputElement).value || "").trim().slice(0, 300),
        ariaLabel: element.getAttribute("aria-label"),
        targetId: element.getAttribute("data-target-id"),
        disabled: (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true",
        visible,
        position: style.position,
        fixedAncestor,
        bbox: visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
      };
    })
  ) as InteractiveElementSnapshot[];

  const target = targetId ? interactiveElements.find((element) => element.targetId === targetId) ?? null : null;
  const blockerLocator = page.locator("[data-blocker-id]:visible").first();
  const blockerCount = await blockerLocator.count();
  const blockerId = blockerCount > 0 ? await blockerLocator.getAttribute("data-blocker-id") : null;
  const blockerBBox = blockerCount > 0 ? await blockerLocator.boundingBox() : null;
  const targetBBox = target?.bbox ?? null;
  const targetInViewport = Boolean(
    targetBBox &&
      targetBBox.x + targetBBox.width > 0 &&
      targetBBox.y + targetBBox.height > 0 &&
      targetBBox.x < viewport.width &&
      targetBBox.y < viewport.height
  );

  return {
    url: page.url(),
    title,
    workflowState: await getWorkflowState(page),
    pageText,
    accessibility,
    interactiveElements,
    targetId,
    targetBBox,
    blockerBBox,
    blockerId,
    targetVisible: target?.visible ?? false,
    targetDisabled: target?.disabled ?? false,
    targetInViewport,
    occlusionRatio: intersectionRatio(targetBBox, blockerBBox),
    overlayPresent: blockerCount > 0,
    viewport
  };
}

