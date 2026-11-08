import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMetaSystemTokenInfo } from "./getMetaSystemTokenInfo";
import { handleSetupMetaWebhook } from "./handleSetupMetaWebhook";

const mocks = vi.hoisted(() => ({
  env: {
    WHATSAPP_CLOUD_API_URL: "https://graph.facebook.com",
    WHATSAPP_CLOUD_API_VERSION: "v26.0",
  },
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@typebot.io/env", () => ({ env: mocks.env }));
vi.mock("@typebot.io/lib/ky", () => ({
  ky: { get: mocks.get, post: mocks.post },
}));
vi.mock("@typebot.io/lib/createToastORPCError", () => ({
  createToastORPCError: vi.fn((error: unknown) => error),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.WHATSAPP_CLOUD_API_URL = "https://graph.facebook.com";
  mocks.env.WHATSAPP_CLOUD_API_VERSION = "v26.0";
  mocks.post.mockResolvedValue(undefined);
});

describe("Meta Graph API version migration", () => {
  it.each([
    ["https://graph.facebook.com", "v26.0"],
    ["https://meta-proxy.example/graph", "v25.0"],
  ])("preserves token inspection through %s/%s", async (baseUrl, version) => {
    mocks.env.WHATSAPP_CLOUD_API_URL = baseUrl;
    mocks.env.WHATSAPP_CLOUD_API_VERSION = version;
    const response = {
      data: {
        app_id: "app-id",
        application: "Example app",
        expires_at: 0,
        scopes: ["whatsapp_business_management"],
      },
    };
    mocks.get.mockReturnValue({ json: vi.fn().mockResolvedValue(response) });

    await expect(
      getMetaSystemTokenInfo({ systemUserAccessToken: "token+/=" }),
    ).resolves.toEqual(response);

    expect(mocks.get).toHaveBeenCalledOnce();
    const [requestUrl, options] = mocks.get.mock.calls[0];
    const url = new URL(String(requestUrl));
    expect(`${url.origin}${url.pathname}`).toBe(
      `${baseUrl}/${version}/debug_token`,
    );
    expect(url.searchParams.get("input_token")).toBe("token+/=");
    expect(url.searchParams.has("appsecret_proof")).toBe(false);
    expect(options).toEqual({
      headers: { Authorization: "Bearer token+/=" },
    });
  });

  it.each([
    ["https://graph.facebook.com", "v26.0"],
    ["https://meta-proxy.example/graph", "v25.0"],
  ])("preserves setup and pagination through %s/%s", async (baseUrl, version) => {
    mocks.env.WHATSAPP_CLOUD_API_URL = baseUrl;
    mocks.env.WHATSAPP_CLOUD_API_VERSION = version;
    const nextUrl = `${baseUrl}/${version}/waba-id/phone_numbers?after=cursor`;
    mocks.get
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ data: { app_id: "app-id" } }),
      })
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({
          data: [],
          paging: { next: nextUrl },
        }),
      })
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({
          data: [{ id: "phone-id", display_phone_number: "+1 631-555-5555" }],
        }),
      })
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ data: [] }),
      });

    await expect(
      handleSetupMetaWebhook({
        input: {
          systemToken: "token",
          appSecret: "secret",
          wabaId: "waba-id",
          phoneNumberId: "phone-id",
          subscribe: true,
        },
      }),
    ).resolves.toMatchObject({
      wabaId: "waba-id",
      subscribedAppId: "app-id",
      wasAlreadySubscribed: false,
    });

    expect(mocks.get).toHaveBeenCalledTimes(4);
    expect(mocks.post).toHaveBeenCalledOnce();
    const getUrls = mocks.get.mock.calls.map(
      ([requestUrl]) => new URL(String(requestUrl)),
    );
    expect(getUrls.map((url) => `${url.origin}${url.pathname}`)).toEqual([
      `${baseUrl}/${version}/debug_token`,
      `${baseUrl}/${version}/waba-id/phone_numbers`,
      `${baseUrl}/${version}/waba-id/phone_numbers`,
      `${baseUrl}/${version}/waba-id/subscribed_apps`,
    ]);
    expect(getUrls[1].searchParams.get("fields")).toBe("id,display_phone_number");
    expect(getUrls[1].searchParams.get("limit")).toBe("100");
    expect(getUrls[2].searchParams.get("after")).toBe("cursor");
    const [postRequestUrl] = mocks.post.mock.calls[0];
    const postUrl = new URL(String(postRequestUrl));
    expect(`${postUrl.origin}${postUrl.pathname}`).toBe(
      `${baseUrl}/${version}/waba-id/subscribed_apps`,
    );
    const proof = createHmac("sha256", "secret").update("token").digest("hex");
    for (const url of [...getUrls, postUrl]) {
      expect(url.searchParams.get("appsecret_proof")).toBe(proof);
    }
    for (const [, options] of [
      ...mocks.get.mock.calls,
      ...mocks.post.mock.calls,
    ]) {
      expect(options).toEqual({ headers: { Authorization: "Bearer token" } });
    }
  });

  it.each([
    { id: "app-id" },
    { whatsapp_business_api_data: { id: "app-id" } },
  ])("does not resubscribe an existing app: %j", async (subscribedApp) => {
    mocks.get
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ data: { app_id: "app-id" } }),
      })
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({
          data: [{ id: "phone-id", display_phone_number: "+1 631-555-5555" }],
        }),
      })
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({ data: [subscribedApp] }),
      });

    await expect(
      handleSetupMetaWebhook({
        input: {
          systemToken: "token",
          wabaId: "waba-id",
          phoneNumberId: "phone-id",
          subscribe: true,
        },
      }),
    ).resolves.toMatchObject({ wasAlreadySubscribed: true });
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
