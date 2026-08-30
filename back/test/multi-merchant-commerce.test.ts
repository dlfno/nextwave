import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import { Es256CheckoutSigner } from "../src/modules/commerce/checkout-signer.js";
import {
  MockAeroSurCommerceProvider,
  MockNubeViaCommerceProvider,
} from "../src/modules/commerce/mock-vuelaya-commerce-provider.js";
import {
  AEROSUR_MERCHANT_ID,
  NUBEVIA_MERCHANT_ID,
} from "../src/modules/discovery/mock-multi-merchant-providers.js";

async function signer() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return Es256CheckoutSigner.create(
    await exportJWK(privateKey),
    "multi-merchant-test-key",
  );
}

describe("multi-merchant authoritative commerce adapters", () => {
  it("refreshes the AeroSur discovery price and returns merchant-owned route facts", async () => {
    const provider = new MockAeroSurCommerceProvider(await signer());
    const quote = await provider.getLiveQuote(
      {
        offerId: "offer-1",
        merchantId: AEROSUR_MERCHANT_ID,
        merchantProductId: "AS-MEX-COR-118",
        productId: null,
        productName: "Untrusted discovery label",
        category: "travel.flight",
        discoveredUnitPriceMinor: 11_800n,
        currency: "USD",
        departureDate: "2026-10-04",
      },
      new Date("2026-08-30T12:00:00Z"),
    );

    expect(quote.totalMinor).toBe(12_500n);
    expect(quote.lineItems[0]).toMatchObject({
      productName: "AeroSur Mexico City to Córdoba",
      originIata: "MEX",
      destinationIata: "COR",
      departureDate: "2026-10-04",
    });
  });

  it("rejects a product identifier that is not in the selected merchant catalog", async () => {
    const provider = new MockNubeViaCommerceProvider(await signer());
    await expect(
      provider.getLiveQuote(
        {
          offerId: "offer-2",
          merchantId: NUBEVIA_MERCHANT_ID,
          merchantProductId: "AS-MEX-COR-118",
          productId: null,
          productName: "Cross-merchant replay",
          category: "travel.flight",
          discoveredUnitPriceMinor: 11_800n,
          currency: "USD",
        },
        new Date("2026-08-30T12:00:00Z"),
      ),
    ).rejects.toMatchObject({ code: "OFFER_NO_LONGER_AVAILABLE" });
  });
});
