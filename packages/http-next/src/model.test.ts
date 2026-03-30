import { describe, it, expect, vi } from "vitest";
import { defineModel, loadModel } from "./model";

describe("defineModel / loadModel", () => {
  it("将 loadModel 的参数原样传给 create 并返回结果", async () => {
    const spy = vi.fn((a: number, b: string) => ({ sum: a + b.length }));
    const m = defineModel(spy);
    const r = await loadModel(m, 2, "hi");
    expect(spy).toHaveBeenCalledWith(2, "hi");
    expect(r).toEqual({ sum: 4 });
  });

  it("每次 loadModel 都会调用 create", async () => {
    const spy = vi.fn().mockResolvedValue(1);
    const m = defineModel(spy);
    await loadModel(m);
    await loadModel(m);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("无参 create：loadModel(model) 不传参", async () => {
    const m = defineModel(() => ({ ok: true }));
    expect(await loadModel(m)).toEqual({ ok: true });
  });

  it("create 返回 Promise", async () => {
    const m = defineModel(async (id: string) => `id:${id}`);
    expect(await loadModel(m, "x")).toBe("id:x");
  });

  it("create 抛错时 Promise reject", async () => {
    const m = defineModel(() => {
      throw new Error("fail");
    });
    await expect(loadModel(m)).rejects.toThrow("fail");
  });

  it("非法第一个参数抛出 TypeError", async () => {
    await expect(loadModel({} as never)).rejects.toThrow(TypeError);
  });
});
