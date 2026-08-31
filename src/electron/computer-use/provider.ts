import type {
  ComputerUseAxElementResult,
  ComputerUseAxFocusResult,
  ComputerUseAxPressResult,
  ComputerUseFocusedElementResult,
  ComputerUseFrontmostApp,
  ComputerUseHelperApp,
  ComputerUseHelperKeypressSpec,
  ComputerUseHelperMouseButton,
  ComputerUseHelperStatus,
  ComputerUseHelperWindow,
  ComputerUseScreenshotPayload,
} from "./helper-runtime";
import { ComputerUseHelperRuntime } from "./helper-runtime";

export interface ComputerUseProvider {
  getHelperPath(): string;
  getHelperSourcePath(): string | null;
  getStatus(): Promise<ComputerUseHelperStatus>;
  ensureReadyWithInteractivePermissions(): Promise<void>;
  stop(): void;
  listApps(): Promise<ComputerUseHelperApp[]>;
  listWindows(pid: number): Promise<ComputerUseHelperWindow[]>;
  getFrontmost(): Promise<ComputerUseFrontmostApp>;
  screenshot(windowId: number): Promise<ComputerUseScreenshotPayload>;
  axPressAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<ComputerUseAxPressResult>;
  axFocusAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<ComputerUseAxFocusResult>;
  axDescribeAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<Record<string, unknown>>;
  axFindTextInput(args: { pid: number; windowId?: number }): Promise<ComputerUseAxElementResult>;
  axFocusTextInput(args: { pid: number; windowId?: number }): Promise<ComputerUseAxElementResult>;
  axFindFocusableElement(args: {
    pid: number;
    windowId?: number;
    roles?: string[];
  }): Promise<ComputerUseAxElementResult>;
  axFindActionableElement(args: {
    pid: number;
    windowId?: number;
    roles?: string[];
  }): Promise<ComputerUseAxElementResult>;
  focusedElement(pid: number): Promise<ComputerUseFocusedElementResult>;
  setValue(elementRef: string, value: string): Promise<void>;
  mouseClick(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
    button?: ComputerUseHelperMouseButton;
    clickCount?: number;
  }): Promise<void>;
  mouseMove(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
  }): Promise<void>;
  mouseDrag(args: {
    windowId: number;
    pid: number;
    path: Array<{ x: number; y: number }>;
    captureWidth: number;
    captureHeight: number;
  }): Promise<void>;
  scrollAtPoint(args: {
    windowId: number;
    pid: number;
    x: number;
    y: number;
    captureWidth: number;
    captureHeight: number;
    scrollX: number;
    scrollY: number;
  }): Promise<void>;
  typeText(text: string, pid: number, windowId?: number): Promise<void>;
  pressKeys(spec: ComputerUseHelperKeypressSpec & { windowId?: number }): Promise<void>;
  activateApp(pid: number): Promise<void>;
  raiseWindow(pid: number, windowId?: number): Promise<void>;
  unminimizeWindow(pid: number, windowId?: number): Promise<void>;
  openPermissionPane(kind: "accessibility" | "screenRecording"): Promise<void>;
}

let providerFactory: (() => ComputerUseProvider) | null = null;

export function getComputerUseProvider(): ComputerUseProvider {
  return providerFactory?.() ?? ComputerUseHelperRuntime.getInstance();
}

export function setComputerUseProviderFactoryForTesting(
  factory: (() => ComputerUseProvider) | null,
): void {
  providerFactory = factory;
}
