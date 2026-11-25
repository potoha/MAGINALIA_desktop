import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_COLLECTOR_BODY,
  FIRST_RUN_COLLECTOR_FAILED,
  bindFirstRunCollectorGuide,
} from "./first-run-collector-guide";

function stubButton() {
  const listeners: Array<() => void> = [];
  return { button: { addEventListener: (_type: "click", listener: () => void) => { listeners.push(listener); } }, click: () => listeners.forEach((listener) => listener()) };
}

describe("first-run Collector guide", () => {
  it("opens the wizard only when the button is pressed", () => {
    const { button, click } = stubButton();
    let opened = 0;
    expect(bindFirstRunCollectorGuide({ button, openWizard: () => { opened += 1; }, reportError: () => {} })).toBe(true);
    expect(opened).toBe(0);
    click();
    expect(opened).toBe(1);
  });

  it("is not offered (no dead button) when the wizard cannot be opened in this runtime", () => {
    const { button, click } = stubButton();
    const errors: string[] = [];
    expect(bindFirstRunCollectorGuide({ button, openWizard: null, reportError: (message) => errors.push(message) })).toBe(false);
    click();
    expect(errors).toEqual([]);
  });

  it("reports a failure to open instead of throwing", () => {
    const { button, click } = stubButton();
    const errors: string[] = [];
    bindFirstRunCollectorGuide({ button, openWizard: () => { throw new Error("boom"); }, reportError: (message) => errors.push(message) });
    expect(click).not.toThrow();
    expect(errors).toEqual([FIRST_RUN_COLLECTOR_FAILED]);
  });

  it("the guide copy does not favor one browser", () => {
    expect(FIRST_RUN_COLLECTOR_BODY).not.toMatch(/Edge|おすすめ|推奨/u);
  });
});
