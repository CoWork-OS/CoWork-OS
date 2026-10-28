# Secrets Encryption

How CoWork OS encrypts the secrets it stores (provider API keys, MCP and channel
credentials, mailbox tokens and similar), what changed when secrets moved to a data key,
and what happens on upgrade, rollback and keychain changes.

For the wider storage picture, see the [Security Guide](security-guide.md#data-storage).

## At a glance

- Secrets live in the profile's SQLite database (`cowork-os.db`). The file itself is not
  encrypted; each secret is.
- Each secret is encrypted with one random **data key** per profile, using AES-256-GCM.
- The data key is sealed by the **OS keychain**: the macOS Keychain, Windows DPAPI, or the
  Linux Secret Service. It is never written to disk unsealed.
- The sealed data key is kept in two places: `safe-storage-key.json` in the profile folder
  and a reserved row in the database. The database copy is the one that counts.
- Without an OS keychain (the headless daemon, the Linux server package, or Linux without a
  Secret Service), secrets use the app-level key (`app2:` records) as before.

## Why a data key

Electron's `safeStorage` is the bridge to the OS keychain. Electron 45 deprecates its
synchronous calls (`encryptString`, `decryptString`, `isEncryptionAvailable`), and Electron
46 removes them. CoWork reads settings synchronously throughout the main process, so a
direct switch to the asynchronous calls would have meant rewriting every settings reader.

Instead, the keychain now seals one thing, the data key, and CoWork opens it once per start
with the asynchronous call. Every secret is then encrypted and decrypted in process with
that key, synchronously, and the deprecated calls are no longer used.

A side effect: each start makes one keychain request instead of one per secret.

## The data key

The key is 32 random bytes. It is sealed with `safeStorage.encryptStringAsync` and stored
base64-encoded in two places:

| Copy          | Where                                                                 | Notes                                                                    |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Key file      | `<profile>/safe-storage-key.json`: `{"version": 1, "sealed": "..."}` | Mode `0600`. Created exclusively, replaced only by an atomic rename.     |
| Database copy | `secure_settings` row `__safe_storage_data_key__`, value `key:<sealed>` | Authoritative. Left out of settings category listings. |

Values sealed with the data key start with `ck1:`:

```text
"ck1:" (4 bytes) | IV (12 bytes) | GCM tag (16 bytes) | AES-256-GCM ciphertext
```

OS keychain output never starts with these bytes, so a reader can always tell the two apart.

The `ck1:` bytes go inside the same containers as before, so the column formats did not
change:

| Stored value                 | Prefix       | Inside                                              |
| ---------------------------- | ------------ | --------------------------------------------------- |
| Secure settings row          | `os:`        | base64 of a `ck1:` value (or a legacy keychain blob) |
| Value inside a settings row  | `encrypted:` | same (MCP, hooks, tunnels, control plane)           |
| Channel config               | `enc:`       | same                                                 |
| Mailbox field                | `mbox:os:`   | same                                                 |
| Browser vault entry          | `os1:`       | same                                                 |
| MCP webhook secret           | `os:`        | same                                                 |
| App-level fallback record    | `app2:`      | AES-256-GCM with a PBKDF2 key from the machine ID    |

## Opening the key

The desktop app opens the key at startup, right after the database and before anything
reads a setting. On macOS, `cowork run` (the CLI's direct mode) enters through the app and
opens it the same way, without the identity recovery described below. On Windows and Linux
the CLI runs under Node: it has no OS keychain and reads only app-level (`app2:`) secrets,
as before the data key.

1. If this Electron has no asynchronous `safeStorage`, the OS keychain is not available, or
   Linux offers only Electron's fixed-key fallback (see [Linux](#linux)), there is no data
   key: status `unavailable`.
2. If the database holds a copy, the keychain unseals it. If the key file is missing or
   different, it is rewritten from the database copy. Status `loaded`.
3. Otherwise, if the key file exists, the keychain unseals it and the database gets a copy.
   Status `loaded`.
4. If neither exists and no secret is sealed with a data key yet, a new key is created:
   the file first (exclusive create, so two processes starting together end up with one
   key), then the database copy. Status `created`.
5. If neither exists but some secret is already sealed with a data key, the key was lost.
   CoWork does not create a new one, because that would orphan those secrets while
   looking like success. Status `unreadable`.
6. If the keychain cannot unseal the stored key, the status is also `unreadable`. A key
   file that exists is never replaced.

On macOS, `unreadable` gets one more attempt. The app's keychain identity can change, for
example when it runs under a former name. CoWork then asks the legacy-identity worker to
unseal the key under each former name (`cowork-os`, `Electron`, `cowork-oss`,
`com.cowork-os.app`, `com.github.Electron`, `Chromium`). If one succeeds, the key is
re-sealed with the current keychain and stored in both places (status `recovered`). No
secret has to be rewritten.

With status `unavailable` or `unreadable`, CoWork works as it did before the data key. New
secrets are sealed by the OS keychain directly while Electron still has the synchronous
call, or with the app-level key when there is no keychain. Secrets it cannot read are
treated as missing (see [Unreadable settings](security-guide.md#encryption-layers)).

## Moving existing secrets onto the key

The first start with a data key re-encrypts what older versions sealed with the keychain
directly. Decryption uses the asynchronous keychain call, so this keeps working after
Electron 46.

1. **Secure settings.** The keychain identity canary moves first, then each row, including
   every `encrypted:` value inside it. A row is replaced only at the revision it was read at,
   so a save made meanwhile wins.
2. **Channel configs** (`enc:`), each replaced only if it is unchanged.
3. **Mailbox fields** (`mbox:os:`), after the window is up, because mailbox content can be
   large.

A value the keychain cannot read is left as it is. Anything not moved is retried at the
next start. Until it moves, a value is still read through the synchronous keychain call,
which Electron 45 still has. The log says so once per process.

### Not moved at startup yet

These stores use the data key for everything they write from now on, but values they
wrote before the upgrade stay sealed by the keychain directly until they are rewritten:

| Store                                     | Where                                                    |
| ----------------------------------------- | -------------------------------------------------------- |
| Browser vault entries (`os1:`)            | `browser-vault` secure settings category, inside the row |
| MCP webhook secrets                       | `mcp_event_subscriptions.secret_encrypted`               |
| Taught-task recordings for bots           | `<profile>/bot-taught-tasks/`                            |
| Memory retirement backups (`.json.enc`)   | `<profile>/backups/`                                     |
| Legacy voice keys (`voice-keys.enc`)      | Read once by the voice settings migration                |

Electron 45 still reads them. They need to move before CoWork upgrades to Electron 46.

## Platforms

### macOS

The keychain item is **CoWork OS Safe Storage** (account `CoWork OS Key`) in the login
keychain. Development and packaged builds use the same name, so they share it. A Mac that
ran an early version can also have an older item with the same name and account
`CoWork OS`; the current versions don't use it.

Releases are ad hoc signed, so macOS treats each release as a different app. After an
update, macOS may ask once whether CoWork OS may use the item. Choose **Always Allow**. This
prompt is not new. With the data key there is one keychain request per start, where before
there was one per secret.

### Windows

Electron protects its own encryption key with DPAPI and stores it in the `Local State` file
of the profile folder. Only the same Windows user on the same machine can unseal it. Copying
a profile to another user or machine does not carry readable secrets.

### Linux

Electron uses the desktop's Secret Service (GNOME Keyring, KWallet), picked from the desktop
session. Without one, Electron falls back to a fixed, built-in key (the `basic_text`
backend), which protects nothing. CoWork treats that as no OS keychain: secrets use the
app-level key (`app2:`), no data key is created, and the browser vault stays off.

Electron's synchronous probe reported no encryption on that fallback, but the asynchronous
probe reports it as available, so CoWork checks the backend itself. A data key created on
that fallback by an unreleased build before this check still opens, so its secrets stay
readable.

### Headless daemon and Linux server package

These run under Node, not Electron, so there is no OS keychain. Secrets use the app-level
key, as before. They cannot read secrets that the desktop app sealed with the keychain or
the data key, as before.

## Upgrading

Nothing to do. On the first start of a version with the data key:

1. The key is created and stored in the key file and the database.
2. Secure settings, channel configs and mailbox fields move onto it.
3. The log shows `Created the data key that seals secrets.` and
   `Re-encrypted secure settings with the data key.`

Every later start opens the key with one keychain request.

## Rolling back

Versions before the data key (0.5.61 and earlier) cannot read secrets sealed with it. If you
roll back, the older version:

- shows your provider keys and other secrets as missing,
- logs that the OS keychain key differs from the one that encrypted existing settings, and
  refuses to save secure settings,
- leaves every stored secret as it is.

Installing the newer version again makes them readable again.

Do **not** relaunch the older version with `COWORK_ACCEPT_NEW_KEYCHAIN_KEY=1`. That moves the
secrets it cannot read into `secure_settings_unreadable_backup` and continues without them,
and the newer version does not bring them back from there.

## Backups and moving a profile

- Back up the whole profile folder. The database alone is enough for secrets, because it
  holds the sealed key, but the key file does no harm.
- A restored profile reads its secrets only on the same machine and user account, with the
  same OS keychain. On another machine, re-enter them. This was already the case before the
  data key.

## Log messages

| Message                                                                                     | Meaning                                                                                       |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Created the data key that seals secrets.`                                                  | First start with the data key.                                                                |
| `Re-encrypted secure settings with the data key.`                                           | Secrets sealed by the keychain directly moved onto the key.                                   |
| `Re-encrypted channel configs with the data key.` / `... mailbox values ...`                | Same, for channel configs or mailbox fields.                                                  |
| `Recovered the secrets data key from a legacy macOS Keychain identity.`                     | The keychain identity changed; the key was unsealed under a former name.                      |
| `Re-sealed the secrets data key with the current OS keychain.`                              | That key is now sealed by the current identity.                                               |
| `The secrets data key is sealed by an OS keychain this process cannot use, or is missing; …` | `unreadable`: the keychain cannot open the key, or the key is lost. Secrets stay on the keychain path. |
| `Read a secret still sealed by the OS keychain directly; …`                                 | A value has not moved onto the key yet.                                                        |
| `(electron) 'safeStorage.…' is deprecated …`                                                | Something used a deprecated synchronous call. With the data key open, this should not appear. |

## Security properties

- The data key exists unsealed only in the memory of the CoWork process that opened it. The
  key file and the database copy are useless without the OS keychain of the same user and
  app identity.
- The trust boundary is unchanged. Code that can ask the keychain as CoWork, or read CoWork's
  memory, could already decrypt every secret through `safeStorage`.
- AES-GCM authenticates each value, so a modified ciphertext fails to open instead of
  decrypting to something else.
- One key covers a profile's secrets. The keychain's own Safe Storage key already did.
- There is no key rotation yet.

## Testing

Unit tests:

- `src/electron/utils/__tests__/safe-storage-data-key.test.ts`: create, load, the exclusive
  create, and the sealed format.
- `src/electron/utils/__tests__/safe-storage-rewrap.test.ts`: `encrypted:`, channel config
  and mailbox rewraps.
- `src/electron/database/__tests__/secure-settings-data-key-rewrap.test.ts`: rows and canary
  moved, a concurrent save winning, the database copy restoring a lost file, refusing to
  create a new key while data-key secrets exist, and identity recovery.
- `src/electron/utils/__tests__/mac-safe-storage-migration.test.ts`: asynchronous probes
  and the legacy-identity recovery of the key.

Upgrade test on a real keychain: `scripts/qa/secrets-upgrade-smoke.mjs` takes a disposable
profile from a previous release to this build:

1. The previous release saves an API key.
2. On the first start, the key is created and secrets move, with no deprecation warning.
3. On a second start, nothing moves.
4. `cowork run` sends the right key.
5. A deleted key file is restored from the database.
6. Rolling back leaves the secrets untouched.
7. Upgrading again reads them.

```bash
node scripts/qa/secrets-upgrade-smoke.mjs --baseline <previous app or package dir> --current <this build>
```

The **Secrets Upgrade Smoke** workflow (`.github/workflows/secrets-upgrade-smoke.yml`) runs
it on pull requests that touch this code. It also runs on demand before a release:

| Leg                        | From                                  | To                                            |
| -------------------------- | ------------------------------------- | --------------------------------------------- |
| macOS app                  | the previous release's zip            | this build, packaged and ad hoc signed        |
| Windows installer          | the previous release's NSIS installer | this build, packaged                          |
| Linux npm, Secret Service  | the previous npm release              | this checkout, with GNOME Keyring             |
| Linux npm, no keyring      | the previous npm release              | this checkout, no keyring (app-level key)     |

## Code map

| Piece                                                 | File                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Data key, `ck1:` format, `getSafeStorage()`           | `src/electron/utils/safe-storage.ts`                   |
| Startup rewrap of `encrypted:`, channel configs, mailbox | `src/electron/utils/safe-storage-rewrap.ts`            |
| Database copy, `openDataKey`, row and canary rewrap   | `src/electron/database/SecureSettingsRepository.ts`    |
| Legacy-identity recovery (macOS)                      | `src/electron/utils/mac-safe-storage-migration.ts`     |
| Startup order                                         | `src/electron/main.ts` (`openSafeStorageDataKey`, `rewrapSecretsWithDataKey`) |
| CLI direct run                                        | `src/cli/direct-run.ts`                                |
