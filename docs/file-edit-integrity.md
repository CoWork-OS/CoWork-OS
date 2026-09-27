# File edit integrity and recovery

`edit_file` retains an open descriptor and rechecks target, parent and permission identity around
mutation. It rereads current content before writing and reapplies the requested exact replacement;
independent changes survive when the replacement still matches unambiguously, otherwise it returns
a conflict. `replace_all` also requires the original match count. Writes stay on the same inode,
preserving hard links and existing file metadata.

Within one user-data profile, cooperating processes contend on a private recovery record keyed by
device/inode, including when they use different hard-link names. An in-process queue serializes
the same identity. Separate profiles and arbitrary external editors do not share this coordination;
this is not a filesystem compare-and-swap guarantee.

Before mutation, the tool stores fsynced before/after bytes and hashes under the active profile's
`edit-recovery` directory. It writes through the held descriptor and checks the result. A failed
write or process termination can leave partial file contents. The private record retains both
versions for reconciliation; it does not claim atomic replacement or power-loss durability.

On a later edit, a live transaction causes a conflict. If a valid orphaned record matches exact
known before/after contents, the tool can discard it without changing the file and then process the
new request. Ambiguous bytes, including an empty file or a prefix of the planned output, are never
automatically overwritten. The error names the retained record and requires explicit reconciliation.
Save the current file first; inspect the record's path, identity and before/after snapshots, and
restore or merge only the version the user intends. A changed inode or malformed record also needs
manual inspection. Reads and startup do not perform recovery.

The configurable file-size guardrail applies to each version, not their combined snapshot. Recovery
storage separately limits each version to 128 MiB, even when the ordinary guardrail is disabled;
the journal permits both versions plus encoding overhead. Oversized targets fail before mutation.

The shared user-data resolver supports desktop, direct CLI and Node daemon profiles. POSIX record
ownership and mode checks protect the recovery directory; Windows uses the user-data directory ACL.
Focused tests cover actual files, symlinks, hard links, separate-process contention, partial writes,
SIGKILL, external edits, guardrail settings and reconciliation. Windows runtime and power-loss
behavior need separate acceptance evidence.
