# Device Authentication and Pairing Contracts

## Scenario: QR-Initiated Device Enrollment and Credential Rotation

### 1. Scope / Trigger

Apply this contract when modifying QR pairing, device proof, opaque access or
refresh credentials, authentication routes, device revocation, or device-bound
WebSocket tracking. It prevents a copied QR payload, replayed challenge, or
superseded refresh credential from becoming durable control authority.

### 2. Signatures

```ts
new DeviceAuthService(options): DeviceAuthService;
service.createPairing(): CreatedPairing;
service.registerPairingDevice(input): PairingRegistration;
service.approvePairing(input): PairedDevice;
service.createPairingClaimChallenge(pairingId): DeviceChallenge;
service.claimPairingCredentials(input): Promise<IssuedDeviceCredentials>;
service.createRefreshChallenge(deviceId): DeviceChallenge;
service.refreshCredentials(input): Promise<IssuedDeviceCredentials>;
service.authenticateAccessToken(token): AuthenticatedDevice;
service.revokeDevice(deviceId): boolean;
```

Remote routes are under `/v1/pair/*` and `/v1/auth/*`. Local-only pairing and
device administration routes are under `/admin/*` and inherit the local-admin
CSRF boundary. SQLite additions are `access_tokens`, `auth_challenges`, and
the device-registration/delivery columns on `pairings`.

### 3. Contracts

- `POST /admin/pairings` reads the configured mobile base URL and creates a
  five-minute pairing. Its QR payload is `{ version, agentId, baseUrl,
  pairingId, expiresAt }`; it contains neither access nor refresh credentials.
- `POST /v1/pair/:pairingId/register` accepts a trimmed device name and a
  raw 32-byte Ed25519 public key encoded as canonical base64url. It consumes
  the pairing registration once and returns the six-digit verification code to
  the scanning device. The same encrypted code is visible only through
  `GET /admin/pairings/pending` on the local listener.
- `POST /admin/pairings/:pairingId/approve` requires that six-digit code and
  creates a device record. The device next obtains a fresh one-time claim
  challenge and signs its exact `message` string with its Ed25519 private key
  before `POST /v1/pair/:pairingId/claim` issues its first credentials.
- If a claim response is lost, the same approved device may obtain a new
  challenge before the five-minute pairing expires and claim again. The Agent
  supersedes the undelivered credential chain first, so this recovery path does
  not leave multiple active refresh roots.
- Access credentials have the shape `ppat.<uuid>.<32-byte-secret>` and expire
  after one hour. Refresh credentials use `pprt.<uuid>.<32-byte-secret>` and
  expire after thirty days without use. The plaintext secret is returned only
  in the issuing response; SQLite stores an AES-GCM-encrypted SHA-256 verifier
  bound to the table, column, and record ID.
- Each refresh requires a separate five-minute server challenge from
  `/v1/auth/refresh-challenge/:deviceId` and a signature over the returned
  canonical message. A successful refresh atomically marks its predecessor
  superseded and issues exactly one new access/refresh pair.
- A valid superseded refresh credential is a reuse event: revoke the device,
  mark its active access rows revoked, close all registered device sockets with
  WebSocket code `4003`, and return `REFRESH_TOKEN_REUSED`. Access-token
  authentication also checks device and token revocation state on every use.
- `InMemoryDeviceConnectionRegistry` owns the device-to-socket mapping. Both
  `/v1/events` and `/v1/tasks/{taskId}/agent` authenticate during the handshake,
  register only after successful authentication, and unregister on close.
  They share this registry so revocation closes control and provider-native
  Agent sockets for
  only the affected device with code `4003`.
- Remote authentication route Zod schemas are also the generated mobile
  OpenAPI source. Pair registration, claim, and refresh-proof routes are public
  bootstrap operations; `/v1/auth/session` declares `bearerAuth`. Every route
  documents the same stable `{ code, message }` error shape used at runtime.
- `pruneStorage` removes expired access tokens and challenges. Superseded
  refresh rows remain so reuse can be detected; reset and rekey include every
  relevant Agent-owned row.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Mobile base URL absent | `MOBILE_BASE_URL_NOT_CONFIGURED` (409); create no pairing. |
| Pairing expired or previously registered | `PAIRING_EXPIRED` (410) or `PAIRING_ALREADY_USED` (409). |
| Invalid raw Ed25519 key or signature | `DEVICE_PUBLIC_KEY_INVALID` (409) or `DEVICE_PROOF_INVALID` (401). |
| Local approval code differs | `PAIRING_VERIFICATION_CODE_MISMATCH` (409); create no device. |
| Claim before local approval | `PAIRING_NOT_APPROVED` (409). |
| Challenge missing, expired, or consumed | `CHALLENGE_NOT_FOUND` (404), `CHALLENGE_EXPIRED` (410), or `CHALLENGE_ALREADY_USED` (409). |
| Refresh token malformed or verifier mismatch | `REFRESH_TOKEN_INVALID` (401). |
| Refresh credential idle for 30 days | `REFRESH_TOKEN_EXPIRED` (401); user pairs again. |
| Verified superseded refresh credential | Revoke device, close its sockets, return `REFRESH_TOKEN_REUSED` (401). |
| Access credential expired/revoked | `ACCESS_TOKEN_EXPIRED` or `ACCESS_TOKEN_REVOKED` (401). |
| WebSocket handshake has a missing/invalid/revoked access credential | Close `4003`; register no subscription and expose no auth detail. |

### 5. Good / Base / Bad Cases

- Good: QR registration creates a local pending record; matching local approval
  followed by a signed claim gives that one device its first credentials.
- Base: a new database has no Agent identity. The first pairing stores a random
  UUID Agent ID under `auth.agent-identity`; later QR payloads reuse it.
- Bad: returning a refresh token in the QR, storing a plaintext token or only a
  hash without its encrypted envelope, accepting a signature for a different
  challenge, or leaving old device sockets open after reuse/revocation.

### 6. Tests Required

- Service tests cover pairing, encrypted verifier-backed issuance, approved
  device claim, access authentication, refresh rotation, refresh reuse
  revocation, pairing/challenge expiry, inactivity expiry, and multi-device
  isolation.
- Remote/local `app.inject()` test proves remote registration/claim work, the
  remote listener returns 404 for local approval, and local approval rejects a
  request lacking CSRF.
- OpenAPI generation tests prove authentication operations have stable unique
  operation IDs and only access-protected operations declare Bearer security.
- Connection-registry and WebSocket integration tests prove revoking device A
  closes only A's control/Agent sockets with code `4003`, while device B stays
  connected.
- Storage maintenance test inserts an access-token envelope and proves rekey
  migrates it with the other encrypted records; pruning removes expired access
  and challenge state.

### 7. Wrong vs Correct

#### Wrong

```ts
return { qrPayload: { baseUrl, pairingId, refreshToken } };
```

A copied QR image becomes durable remote-control authority.

#### Correct

```ts
const challenge = service.createPairingClaimChallenge(pairingId);
const signature = await device.sign(challenge.message);
const credentials = await service.claimPairingCredentials({
  pairingId,
  challengeId: challenge.challengeId,
  signature,
});
```

The QR is short-lived, local approval creates the device identity, and the
device proves current key possession before the Agent returns credentials.
