# Nextwave AP2 flight constraint

AP2 v0.2 permits mandate constraint extensions when they define a unique type,
a schema, and a deterministic evaluation algorithm. Nextwave uses the following
extension in an autonomous open Checkout Mandate when the requested product is
a flight.

## Type and schema

Type: `com.nextwave.checkout.flight.1`

```json
{
  "type": "com.nextwave.checkout.flight.1",
  "category": "travel.flight",
  "origin_iata": "MEX",
  "destination_iata": "COR",
  "departure_date": "2026-09-15",
  "quantity": 1
}
```

- `type` must equal `com.nextwave.checkout.flight.1`.
- `category` must equal `travel.flight`.
- `origin_iata` and `destination_iata` are uppercase three-letter IATA codes.
- `departure_date` is an ISO 8601 calendar date.
- `quantity` is a positive integer.
- No field is selectively disclosable in the hackathon profile because all five
  fields are required to evaluate the proposed checkout.

## Deterministic evaluation

The verifier extracts all flight line items from the merchant-signed checkout.
The constraint passes only when:

1. At least one line item exists and every line item has category
   `travel.flight`.
2. Every line item has the exact requested origin, destination, and departure
   date.
3. Every quantity is a positive integer.
4. The sum of line-item quantities equals `quantity`.
5. No checkout line item is left unmatched and no line item is matched twice.

Nextwave's mandate engine performs these checks against normalized fields loaded
from the signed authoritative checkout. It does not call an LLM.

## Credential profile

The Trusted Surface issues separate `mandate.checkout.open.1` and
`mandate.payment.open.1` delegation credentials. They are encoded as compact
SD-JWT credentials with SHA-256 disclosures and ES256 issuer signatures. Both
contain a `cnf.jwk` bound to a distinct Shopping Agent P-256 key. The open Payment
Mandate references the digest of the associated open Checkout credential.

Live revocation remains an online Nextwave policy in addition to the signed AP2
artifact, so a previously issued credential cannot bypass a later revocation.
