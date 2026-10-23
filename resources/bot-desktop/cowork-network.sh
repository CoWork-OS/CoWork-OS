#!/bin/sh
# Applies a bot desktop's network limit. CoWork runs this once, as root, in a short-lived helper
# container that shares the desktop's network namespace (run --network container:<desktop>
# --cap-add NET_ADMIN), so the desktop itself never holds a network capability.
#
#   cowork-network internet RESOLVER...   public internet only: not this computer, the local
#                                         network, link-local or metadata addresses; DNS only
#                                         to the desktop's own resolvers
#   cowork-network off                    no network at all
#
# IPv6 is closed in both. Any failure exits non-zero and CoWork removes the desktop.
set -eu

mode="${1:-}"
[ "$#" -gt 0 ] && shift
case "$mode" in
  internet | off) ;;
  *)
    echo "usage: cowork-network internet RESOLVER... | off" >&2
    exit 2
    ;;
esac

for resolver in "$@"; do
  case "$resolver" in
    "" | *[!0-9.]*)
      echo "not an IPv4 resolver: $resolver" >&2
      exit 2
      ;;
  esac
done

for table in iptables ip6tables; do
  "$table" -P OUTPUT DROP
  "$table" -F OUTPUT
  "$table" -A OUTPUT -o lo -j ACCEPT
  # Replies to the viewer connection, and to requests this list allowed.
  "$table" -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done

if [ "$mode" = internet ]; then
  for resolver in "$@"; do
    iptables -A OUTPUT -d "$resolver" -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -d "$resolver" -p tcp --dport 53 -j ACCEPT
  done
  # This computer (host.docker.internal is in one of these), the local network, carrier-grade
  # NAT, link-local and cloud metadata, benchmarking, multicast and reserved ranges.
  for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
    192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
    iptables -A OUTPUT -d "$range" -j REJECT
  done
  iptables -A OUTPUT -j ACCEPT
fi

iptables -A OUTPUT -j REJECT
ip6tables -A OUTPUT -j REJECT
echo "network limit applied: $mode"
