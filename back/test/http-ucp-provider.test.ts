import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNubeViaSimulator } from "../src/merchant-simulator/nubevia-app.js";
import {
  HttpUcpCommerceProvider,
  HttpUcpDiscoveryProvider,
} from "../src/modules/commerce/http-ucp-provider.js";
import { NUBEVIA_MERCHANT_ID } from "../src/modules/discovery/mock-multi-merchant-providers.js";
import {
  Ap2CredentialIssuer,
  ap2CheckoutHash,
  ap2CheckoutMandateSchema,
  ap2PaymentMandateSchema,
  ap2TransactionAuthorizationSchema,
} from "../src/modules/mandates/ap2-credential.js";
import type { SearchSpecification } from "../src/modules/purchase-intents/specifications.js";

const OFFER_ID = "30000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "40000000-0000-4000-8000-000000000001";
const QUOTE_ID = "50000000-0000-4000-8000-000000000001";
const MANDATE_ID = "60000000-0000-4000-8000-000000000001";
const MANDATE_VERSION_ID = "70000000-0000-4000-8000-000000000001";

const specification: SearchSpecification = {
  query: "flight from Mexico City to Córdoba",
  category: "travel.flight",
  origin: { city: "Mexico City", iata: "MEX" },
  destination: { city: "Córdoba", country: "Argentina", iata: "COR" },
  departureDate: "2026-09-15",
  passengers: 1,
  currency: "USD",
  rankingPreferences: ["lowest_total_price"],
};

describe("HTTP UCP NubeVia adapters", () => {
  let server: ReturnType<
    Awaited<ReturnType<typeof createNubeViaSimulator>>["listen"]
  >;
  let baseUrl: string;
  let platformIssuer: Ap2CredentialIssuer;

  beforeEach(async () => {
    const { privateKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const platformKeys = await generateKeyPair("ES256", { extractable: true });
    const platformPrivateJwk = await exportJWK(platformKeys.privateKey);
    platformIssuer = await Ap2CredentialIssuer.create(
      platformPrivateJwk,
      "platform-test-key",
      "urn:nextwave:test-platform",
    );
    const platformPublicJwk: JWK = {
      ...platformPrivateJwk,
      kid: "platform-test-key",
      alg: "ES256",
      use: "sig",
    };
    delete platformPublicJwk.d;
    const app = await createNubeViaSimulator({
      privateJwk: await exportJWK(privateKey),
      platformKeys: [platformPublicJwk],
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("discovers, refreshes, signs, verifies, and completes an authoritative checkout", async () => {
    const discovery = new HttpUcpDiscoveryProvider(baseUrl);
    const commerce = new HttpUcpCommerceProvider(baseUrl);
    const profile = (await (
      await fetch(`${baseUrl}/.well-known/ucp`)
    ).json()) as {
      ucp: { version: string; capabilities: Record<string, unknown> };
    };
    expect(profile.ucp.version).toBe("2026-04-08");
    expect(profile.ucp.capabilities).toHaveProperty(
      "dev.ucp.common.payment.ap2_mandate",
    );
    const offers = await discovery.search(specification, {
      observedAt: new Date("2026-08-30T18:00:00Z"),
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      providerId: "http-nubevia-merchant-api",
      merchantId: NUBEVIA_MERCHANT_ID,
      merchantProductId: "NV-MEX-COR-145",
      unitPriceMinor: "14500",
      sourceType: "MERCHANT_API",
    });

    const offer = offers[0];
    if (!offer) throw new Error("Expected a NubeVia offer");
    const quote = await commerce.getLiveQuote(
      {
        offerId: OFFER_ID,
        merchantId: offer.merchantId,
        merchantProductId: offer.merchantProductId,
        productId: offer.productId ?? null,
        productName: offer.productName,
        category: offer.category,
        discoveredUnitPriceMinor: BigInt(offer.unitPriceMinor),
        currency: offer.currency,
        departureDate: specification.departureDate,
      },
      new Date("2026-08-30T18:00:00Z"),
    );
    expect(quote.totalMinor).toBe(14_200n);
    expect(quote.lineItems[0]?.departureDate).toBe(specification.departureDate);

    const checkout = await commerce.createCheckout({
      attemptId: ATTEMPT_ID,
      quoteId: QUOTE_ID,
      mandateId: MANDATE_ID,
      mandateVersionId: MANDATE_VERSION_ID,
      quote,
      currentTime: new Date("2026-08-30T18:00:01Z"),
    });
    expect(await commerce.verifyCheckout(checkout)).toBe(true);
    expect(
      await commerce.verifyCheckout({
        ...checkout,
        payload: { ...checkout.payload, totalMinor: "1" },
      }),
    ).toBe(false);

    const checkoutHash = ap2CheckoutHash(checkout.signedPayload);
    const expiresAt = new Date(Date.now() + 60_000);
    const closedCheckout = ap2CheckoutMandateSchema.parse({
      vct: "mandate.checkout.1",
      checkout_jwt: checkout.signedPayload,
      checkout_hash: checkoutHash,
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(expiresAt.getTime() / 1_000),
    });
    const closedPayment = ap2PaymentMandateSchema.parse({
      vct: "mandate.payment.1",
      transaction_id: checkoutHash,
      payee: { id: NUBEVIA_MERCHANT_ID, name: "NubeVia" },
      payment_amount: { amount: 14_200, currency: "USD" },
      payment_instrument: { id: "wallet-1", type: "mock_constrained_token" },
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(expiresAt.getTime() / 1_000),
    });
    const authorization = ap2TransactionAuthorizationSchema.parse({
      type: "delegate",
      format: "dc+sd-jwt",
      delegate_payload: [closedCheckout, closedPayment],
    });
    const presentation = await platformIssuer.issueDelegation(
      authorization,
      expiresAt,
    );
    const rejected = await fetch(
      `${baseUrl}/checkout-sessions/${checkout.providerCheckoutId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payment: {
            instruments: [
              {
                id: "bad",
                handler_id: "mock",
                type: "tokenized",
                selected: true,
                credential: { type: "PAYMENT_GATEWAY", token: "tampered" },
              },
            ],
          },
          ap2: { checkout_mandate: "tampered" },
        }),
      },
    );
    expect(rejected.status).toBe(400);
    const completed = await commerce.completeCheckout({
      providerCheckoutId: checkout.providerCheckoutId,
      checkoutId: "80000000-0000-4000-8000-000000000001",
      merchantId: NUBEVIA_MERCHANT_ID,
      amountMinor: 14_200n,
      currency: "USD",
      credentialProvider: "mock",
      credentialReference: "mock-credential-reference",
      ap2CheckoutMandate: presentation.compact,
    });
    expect(completed.merchantOrderId).toMatch(/^NV-ORDER-/);
  });

  it("reports an unavailable merchant without falling back to untrusted data", async () => {
    const unavailable = new HttpUcpDiscoveryProvider("http://127.0.0.1:1", 50);
    await expect(
      unavailable.search(specification, { observedAt: new Date() }),
    ).rejects.toMatchObject({ status: 503, code: "UCP_MERCHANT_UNAVAILABLE" });
  });
});
