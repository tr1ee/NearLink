type Lease = { fqdn: string; expires: number };
const ttlMs = (ttl: unknown) =>
  Math.max(2000, Math.min(120000, (Number(ttl) || 120) * 1000));
const normalized = (name: unknown) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/\.$/, "");
/** Renew from actual DNS responses; repeated unchanged TXT records are not
 * emitted as "up" by bonjour-service. Never identify a device by its name. */
export class DiscoveryLeases {
  private leases = new Map<string, Lease>();
  record(id: string, service: any, now = Date.now()) {
    this.leases.set(id, {
      fqdn: normalized(service.fqdn ?? service.name),
      expires: now + ttlMs(service.ttl),
    });
  }
  observe(packet: any, now = Date.now()) {
    const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
    for (const lease of this.leases.values()) {
      const relevant = records.filter(
        (r: any) =>
          (r.type === "PTR"
            ? normalized(r.data)
            : ["SRV", "TXT"].includes(r.type)
              ? normalized(r.name)
              : "") === lease.fqdn,
      );
      const live = relevant.filter((r: any) => r.ttl > 0);
      if (live.length)
        lease.expires = now + Math.min(...live.map((r: any) => ttlMs(r.ttl)));
      else if (relevant.some((r: any) => r.ttl === 0)) lease.expires = now;
    }
  }
  expired(now = Date.now()) {
    const ids: string[] = [];
    for (const [id, lease] of this.leases)
      if (lease.expires <= now) {
        ids.push(id);
        this.leases.delete(id);
      }
    return ids;
  }
  remove(id: string) {
    this.leases.delete(id);
  }
}
