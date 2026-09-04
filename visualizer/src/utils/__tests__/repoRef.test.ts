import { describe, expect, test } from "bun:test";

import { hubResolveUrl, parseRepoRef, shortRevision } from "@/utils/repoRef";
import { buildVersionedUrl } from "@/utils/versionUtils";
import { commitAnnotationsToHub, setEpisodeReviewed } from "@/utils/hubCommit";

describe("repo references with a pinned revision", () => {
  test("plain reference reads main", () => {
    expect(parseRepoRef("Jingyi-Z/sotac")).toEqual({
      repoId: "Jingyi-Z/sotac",
      revision: "main",
      pinned: false,
    });
  });

  test("@revision pins reads to that revision", () => {
    expect(parseRepoRef("Jingyi-Z/sotac@47d46cfb")).toEqual({
      repoId: "Jingyi-Z/sotac",
      revision: "47d46cfb",
      pinned: true,
    });
    expect(
      hubResolveUrl(
        "https://huggingface.co/datasets",
        "Jingyi-Z/sotac@47d46cfb",
        "meta/info.json",
      ),
    ).toBe(
      "https://huggingface.co/datasets/Jingyi-Z/sotac/resolve/47d46cfb/meta/info.json",
    );
  });

  test("an empty @ falls back to main; branch names with slashes are escaped", () => {
    expect(parseRepoRef("a/b@").revision).toBe("main");
    expect(hubResolveUrl("https://x", "a/b@refs/pr/1", "f.json")).toBe(
      "https://x/a/b/resolve/refs%2Fpr%2F1/f.json",
    );
  });

  test("every versioned URL inherits the pin", () => {
    expect(
      buildVersionedUrl(
        "Jingyi-Z/sotac@47d46cfb",
        "v3.0",
        "data/chunk-000/file-000.parquet",
      ),
    ).toBe(
      "https://huggingface.co/datasets/Jingyi-Z/sotac/resolve/47d46cfb/data/chunk-000/file-000.parquet",
    );
  });

  test("short display form", () => {
    expect(shortRevision("47d46cfb82e5d327a0e0790f1414417bddbf3be5")).toBe(
      "47d46cf",
    );
    expect(shortRevision("main")).toBe("main");
  });

  test("a pinned reference refuses Hub writes before touching the network", async () => {
    await expect(
      commitAnnotationsToHub("Jingyi-Z/sotac@47d46cfb", 1, []),
    ).rejects.toThrow(/pinned to revision 47d46cfb/);
    await expect(
      setEpisodeReviewed("Jingyi-Z/sotac@47d46cfb", 1, true),
    ).rejects.toThrow(/pinned to revision/);
  });
});
