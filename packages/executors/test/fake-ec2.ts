/**
 * An in-memory EC2 Query API for tests: enough of the real behavior (ClientToken idempotency,
 * tag filters, one association per Elastic IP, attach/detach states, pending → running on the
 * next describe) to exercise the aws-ec2 executor end to end over `fetch`.
 */
type Tags = Record<string, string>;
type Res = { id: string; tags: Tags; [k: string]: unknown };

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tagXml = (t: Tags) => `<tagSet>${Object.entries(t).map(([k, v]) => `<item><key>${esc(k)}</key><value>${esc(v)}</value></item>`).join('')}</tagSet>`;

export class FakeEc2 {
  addresses = new Map<string, Res & { publicIp: string; eni?: string; assoc?: string }>();
  enis = new Map<string, Res & { subnet: string; az: string; status: string; instance?: string }>();
  volumes = new Map<string, Res & { az: string; size: number; status: string; instance?: string; device?: string; snapshot?: string }>();
  instances = new Map<string, Res & { state: string; az: string; type: string; eni: string; userData: string; protected: boolean; pendingDescribes: number }>();
  snapshots = new Map<string, Res & { volume: string; size: number; status: string; describes: number }>();
  tokens = new Map<string, string>();
  calls: { action: string; params: Record<string, string> }[] = [];
  /** Return an error for a call, e.g. capacity for one instance type. */
  fail: (action: string, p: Record<string, string>) => { code: string; status?: number } | null = () => null;
  subnetAz: Record<string, string> = { 'subnet-a': 'ap-northeast-1a', 'subnet-c': 'ap-northeast-1c' };
  quotas: Record<string, number> = { 'L-0263D0A3': 5, 'L-1216C47A': 16 };
  private n = 0;

  private id(prefix: string) {
    return `${prefix}-${(++this.n).toString(16).padStart(17, '0')}`;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (!req.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256')) return new Response('unsigned', { status: 403 });
    if (req.headers.get('x-amz-target')?.includes('GetServiceQuota')) {
      const body = (await req.json()) as { QuotaCode: string };
      return Response.json({ Quota: { Value: this.quotas[body.QuotaCode] } });
    }
    const p = Object.fromEntries(new URLSearchParams(await req.text()));
    const action = p.Action!;
    this.calls.push({ action, params: p });
    const f = this.fail(action, p);
    if (f) return this.error(f.code, f.status ?? 400);
    try {
      return this.ok(action, this.handle(action, p));
    } catch (e) {
      const [code, status] = String((e as Error).message).split('|');
      return this.error(code!, Number(status ?? 400));
    }
  };

  private ok(action: string, body: string) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>r</requestId>${body}</${action}Response>`, { status: 200 });
  }
  private error(code: string, status: number) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error><Code>${code}</Code><Message>${code} (fake)</Message></Error></Errors><RequestID>r</RequestID></Response>`, { status });
  }

  private list(p: Record<string, string>, prefix: string): string[] {
    return Object.keys(p).filter((k) => new RegExp(`^${prefix.replace('.', '\\.')}\\.\\d+$`).test(k)).map((k) => p[k]!);
  }
  private tagsFrom(p: Record<string, string>, type: string): Tags {
    for (let n = 1; p[`TagSpecification.${n}.ResourceType`]; n++) {
      if (p[`TagSpecification.${n}.ResourceType`] !== type) continue;
      const t: Tags = {};
      for (let i = 1; p[`TagSpecification.${n}.Tag.${i}.Key`]; i++) t[p[`TagSpecification.${n}.Tag.${i}.Key`]!] = p[`TagSpecification.${n}.Tag.${i}.Value`] ?? '';
      return t;
    }
    return {};
  }
  private filters(p: Record<string, string>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (let i = 1; p[`Filter.${i}.Name`]; i++) out[p[`Filter.${i}.Name`]!] = this.list(p, `Filter.${i}.Value`);
    return out;
  }
  private match(r: Res, f: Record<string, string[]>, fields: Record<string, (r: Res) => string | undefined>): boolean {
    return Object.entries(f).every(([name, values]) => {
      if (name.startsWith('tag:')) return values.includes(r.tags[name.slice(4)] ?? '\u0000');
      const get = fields[name];
      return get ? values.includes(get(r) ?? '\u0000') : true;
    });
  }
  private once(key: string | undefined, create: () => string): string {
    if (!key) return create();
    const existing = this.tokens.get(key);
    if (existing) return existing;
    const id = create();
    this.tokens.set(key, id);
    return id;
  }
  private need<T>(m: Map<string, T>, id: string | undefined, code: string): T {
    const r = id ? m.get(id) : undefined;
    if (!r) throw new Error(`${code}|400`);
    return r;
  }

  private handle(action: string, p: Record<string, string>): string {
    const f = this.filters(p);
    switch (action) {
      case 'AllocateAddress': {
        const id = this.id('eipalloc');
        const ip = `203.0.113.${this.addresses.size + 10}`;
        this.addresses.set(id, { id, tags: this.tagsFrom(p, 'elastic-ip'), publicIp: ip });
        return `<publicIp>${ip}</publicIp><allocationId>${id}</allocationId><domain>vpc</domain>`;
      }
      case 'DescribeAddresses': {
        const ids = this.list(p, 'AllocationId');
        const rows = [...this.addresses.values()].filter((a) => (ids.length ? ids.includes(a.id) : true) && this.match(a, f, {}));
        if (ids.length && !rows.length) throw new Error('InvalidAllocationID.NotFound|400');
        return `<addressesSet>${rows
          .map((a) => `<item><publicIp>${a.publicIp}</publicIp><allocationId>${a.id}</allocationId>${a.eni ? `<networkInterfaceId>${a.eni}</networkInterfaceId><associationId>${a.assoc}</associationId>` : ''}${tagXml(a.tags)}</item>`)
          .join('')}</addressesSet>`;
      }
      case 'AssociateAddress': {
        const a = this.need(this.addresses, p.AllocationId, 'InvalidAllocationID.NotFound');
        this.need(this.enis, p.NetworkInterfaceId, 'InvalidNetworkInterfaceID.NotFound');
        if (a.eni && a.eni !== p.NetworkInterfaceId && p.AllowReassociation !== 'true') throw new Error('Resource.AlreadyAssociated|400');
        // An interface's primary private address has one public address: the old one is released.
        for (const other of this.addresses.values()) if (other.eni === p.NetworkInterfaceId && other.id !== a.id) other.eni = undefined;
        a.eni = p.NetworkInterfaceId;
        a.assoc = this.id('eipassoc');
        return `<associationId>${a.assoc}</associationId>`;
      }
      case 'DisassociateAddress': {
        for (const a of this.addresses.values()) if (a.assoc === p.AssociationId) a.eni = a.assoc = undefined;
        return '<return>true</return>';
      }
      case 'ReleaseAddress': {
        const a = this.need(this.addresses, p.AllocationId, 'InvalidAllocationID.NotFound');
        if (a.eni) throw new Error('InvalidIPAddress.InUse|400');
        this.addresses.delete(a.id);
        return '<return>true</return>';
      }
      case 'CreateNetworkInterface': {
        const id = this.once(p.ClientToken && `eni:${p.ClientToken}`, () => {
          const id = this.id('eni');
          this.enis.set(id, { id, tags: this.tagsFrom(p, 'network-interface'), subnet: p.SubnetId!, az: this.subnetAz[p.SubnetId!]!, status: 'available' });
          return id;
        });
        return `<networkInterface>${this.eniXml(this.enis.get(id)!)}</networkInterface>`;
      }
      case 'DescribeNetworkInterfaces': {
        const ids = this.list(p, 'NetworkInterfaceId');
        const rows = [...this.enis.values()].filter((e) => (ids.length ? ids.includes(e.id) : true) && this.match(e, f, { 'attachment.instance-id': (e) => (e as { instance?: string }).instance }));
        if (ids.length && !rows.length) throw new Error('InvalidNetworkInterfaceID.NotFound|400');
        return `<networkInterfaceSet>${rows.map((e) => `<item>${this.eniXml(e)}</item>`).join('')}</networkInterfaceSet>`;
      }
      case 'DeleteNetworkInterface': {
        const e = this.need(this.enis, p.NetworkInterfaceId, 'InvalidNetworkInterfaceID.NotFound');
        if (e.instance) throw new Error('InvalidNetworkInterface.InUse|400');
        for (const a of this.addresses.values()) if (a.eni === e.id) a.eni = a.assoc = undefined;
        this.enis.delete(e.id);
        return '<return>true</return>';
      }
      case 'CreateVolume': {
        const id = this.once(p.ClientToken && `vol:${p.ClientToken}`, () => {
          const id = this.id('vol');
          this.volumes.set(id, { id, tags: this.tagsFrom(p, 'volume'), az: p.AvailabilityZone!, size: Number(p.Size), status: 'available', snapshot: p.SnapshotId });
          return id;
        });
        const v = this.volumes.get(id)!;
        return `<volumeId>${v.id}</volumeId><size>${v.size}</size><availabilityZone>${v.az}</availabilityZone><status>creating</status>`;
      }
      case 'DescribeVolumes': {
        const ids = this.list(p, 'VolumeId');
        const rows = [...this.volumes.values()].filter(
          (v) => (ids.length ? ids.includes(v.id) : true) && this.match(v, f, { 'attachment.instance-id': (v) => (v as { instance?: string }).instance, 'attachment.device': (v) => (v as { device?: string }).device }),
        );
        if (ids.length && !rows.length) throw new Error('InvalidVolume.NotFound|400');
        return `<volumeSet>${rows
          .map(
            (v) =>
              `<item><volumeId>${v.id}</volumeId><size>${v.size}</size><availabilityZone>${v.az}</availabilityZone><status>${v.status}</status>${v.snapshot ? `<snapshotId>${v.snapshot}</snapshotId>` : ''}<attachmentSet>${v.instance ? `<item><instanceId>${v.instance}</instanceId><device>${v.device}</device><status>attached</status></item>` : ''}</attachmentSet>${tagXml(v.tags)}</item>`,
          )
          .join('')}</volumeSet>`;
      }
      case 'AttachVolume': {
        const v = this.need(this.volumes, p.VolumeId, 'InvalidVolume.NotFound');
        const i = this.need(this.instances, p.InstanceId, 'InvalidInstanceID.NotFound');
        if (v.instance) throw new Error('VolumeInUse|400');
        if (v.az !== i.az) throw new Error('InvalidVolume.ZoneMismatch|400');
        if (i.state !== 'running' && i.state !== 'stopped') throw new Error('IncorrectState|400');
        Object.assign(v, { instance: i.id, device: p.Device, status: 'in-use' });
        return '<status>attaching</status>';
      }
      case 'DetachVolume': {
        const v = this.need(this.volumes, p.VolumeId, 'InvalidVolume.NotFound');
        Object.assign(v, { instance: undefined, device: undefined, status: 'available' });
        return '<status>detaching</status>';
      }
      case 'DeleteVolume': {
        const v = this.need(this.volumes, p.VolumeId, 'InvalidVolume.NotFound');
        if (v.instance) throw new Error('VolumeInUse|400');
        this.volumes.delete(v.id);
        return '<return>true</return>';
      }
      case 'DescribeImages':
        return `<imagesSet><item><imageId>ami-old</imageId><creationDate>2026-01-01T00:00:00.000Z</creationDate></item><item><imageId>ami-new</imageId><creationDate>2026-09-01T00:00:00.000Z</creationDate></item></imagesSet>`;
      case 'RunInstances': {
        const eni = this.need(this.enis, p['NetworkInterface.1.NetworkInterfaceId'], 'InvalidNetworkInterfaceID.NotFound');
        const id = this.once(`i:${p.ClientToken}`, () => {
          const id = this.id('i');
          const root = this.id('vol');
          this.instances.set(id, {
            id,
            tags: this.tagsFrom(p, 'instance'),
            state: 'pending',
            az: eni.az,
            type: p.InstanceType!,
            eni: eni.id,
            userData: atob(p.UserData ?? ''),
            protected: p.DisableApiTermination === 'true',
            pendingDescribes: 1,
          });
          this.volumes.set(root, { id: root, tags: this.tagsFrom(p, 'volume'), az: eni.az, size: 16, status: 'in-use', instance: id, device: '/dev/sda1' });
          Object.assign(eni, { instance: id, status: 'in-use' });
          return id;
        });
        return `<instancesSet><item><instanceId>${id}</instanceId><instanceState><name>pending</name></instanceState></item></instancesSet>`;
      }
      case 'DescribeInstances': {
        const ids = this.list(p, 'InstanceId');
        const rows = [...this.instances.values()].filter((i) => (ids.length ? ids.includes(i.id) : true) && this.match(i, f, { 'instance-state-name': (i) => (i as { state: string }).state }));
        if (ids.length && !rows.length) throw new Error('InvalidInstanceID.NotFound|400');
        for (const i of rows) {
          if ((i.state === 'pending' || i.state === 'stopping') && i.pendingDescribes-- <= 0) i.state = i.state === 'pending' ? 'running' : 'stopped';
        }
        return `<reservationSet>${rows
          .map(
            (i) =>
              `<item><instancesSet><item><instanceId>${i.id}</instanceId><instanceType>${i.type}</instanceType><instanceState><name>${i.state}</name></instanceState><placement><availabilityZone>${i.az}</availabilityZone></placement><cpuOptions><coreCount>1</coreCount><threadsPerCore>2</threadsPerCore></cpuOptions>${tagXml(i.tags)}</item></instancesSet></item>`,
          )
          .join('')}</reservationSet>`;
      }
      case 'StartInstances':
      case 'StopInstances': {
        const i = this.need(this.instances, p['InstanceId.1'], 'InvalidInstanceID.NotFound');
        if (i.state === 'terminated') throw new Error('IncorrectInstanceState|400');
        i.state = action === 'StartInstances' ? 'pending' : 'stopping';
        i.pendingDescribes = 1;
        return `<instancesSet><item><instanceId>${i.id}</instanceId><currentState><name>${i.state}</name></currentState></item></instancesSet>`;
      }
      case 'ModifyInstanceAttribute': {
        const i = this.need(this.instances, p.InstanceId, 'InvalidInstanceID.NotFound');
        if (p['DisableApiTermination.Value'] !== undefined) i.protected = p['DisableApiTermination.Value'] === 'true';
        return '<return>true</return>';
      }
      case 'TerminateInstances': {
        const i = this.need(this.instances, p['InstanceId.1'], 'InvalidInstanceID.NotFound');
        if (i.protected) throw new Error('OperationNotPermitted|400');
        i.state = 'terminated';
        for (const v of [...this.volumes.values()]) {
          if (v.instance !== i.id) continue;
          if (v.device === '/dev/sda1') this.volumes.delete(v.id);
          else Object.assign(v, { instance: undefined, device: undefined, status: 'available' });
        }
        const eni = this.enis.get(i.eni);
        if (eni) Object.assign(eni, { instance: undefined, status: 'available' });
        return '<instancesSet/>';
      }
      case 'CreateSnapshot': {
        const v = this.need(this.volumes, p.VolumeId, 'InvalidVolume.NotFound');
        const id = this.id('snap');
        this.snapshots.set(id, { id, tags: this.tagsFrom(p, 'snapshot'), volume: v.id, size: v.size, status: 'pending', describes: 1 });
        return `<snapshotId>${id}</snapshotId><volumeId>${v.id}</volumeId><volumeSize>${v.size}</volumeSize><status>pending</status>`;
      }
      case 'DescribeSnapshots': {
        const ids = this.list(p, 'SnapshotId');
        const rows = [...this.snapshots.values()].filter((s) => (ids.length ? ids.includes(s.id) : true) && this.match(s, f, {}));
        if (ids.length && !rows.length) throw new Error('InvalidSnapshot.NotFound|400');
        for (const s of rows) if (s.status === 'pending' && s.describes-- <= 0) s.status = 'completed';
        return `<snapshotSet>${rows.map((s) => `<item><snapshotId>${s.id}</snapshotId><volumeSize>${s.size}</volumeSize><status>${s.status}</status>${tagXml(s.tags)}</item>`).join('')}</snapshotSet>`;
      }
      case 'DeleteSnapshot': {
        this.need(this.snapshots, p.SnapshotId, 'InvalidSnapshot.NotFound');
        this.snapshots.delete(p.SnapshotId!);
        return '<return>true</return>';
      }
      default:
        throw new Error('InvalidAction|400');
    }
  }

  private eniXml(e: { id: string; az: string; status: string; tags: Tags; instance?: string }) {
    const a = [...this.addresses.values()].find((x) => x.eni === e.id);
    const assoc = a ? `<association><publicIp>${a.publicIp}</publicIp><allocationId>${a.id}</allocationId></association>` : '';
    return `<networkInterfaceId>${e.id}</networkInterfaceId><availabilityZone>${e.az}</availabilityZone><status>${e.status}</status>${e.instance ? `<attachment><instanceId>${e.instance}</instanceId><status>attached</status></attachment>` : ''}${assoc}<privateIpAddressesSet><item><privateIpAddress>10.40.0.5</privateIpAddress><primary>true</primary>${assoc}</item></privateIpAddressesSet>${tagXml(e.tags)}`;
  }
}
