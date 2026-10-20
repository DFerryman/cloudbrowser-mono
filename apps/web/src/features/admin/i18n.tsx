import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/api.js';
import { setAdminLocale } from './data.js';

/** The operator console's own languages: Chinese by default, English on request. */
export type AdminLocale = 'zh-CN' | 'en';
const STORAGE_KEY = 'cb.admin.locale';

/** [Chinese, English]. `{name}` is replaced by `vars.name`. */
const M = {
  'common.loading': ['加载中…', 'Loading…'],
  'common.empty': ['暂无数据。', 'Nothing here.'],
  'common.cancel': ['取消', 'Cancel'],
  'common.save': ['保存', 'Save'],
  'common.search': ['搜索', 'Search'],
  'common.filter': ['筛选', 'Filter'],
  'common.done': ['已完成', 'Done'],
  'common.saved': ['已保存', 'Saved'],
  'common.on': ['开', 'on'],
  'common.off': ['关', 'off'],
  'common.turnOn': ['开启', 'Turn on'],
  'common.turnOff': ['关闭', 'Turn off'],
  'common.edit': ['编辑', 'Edit'],
  'common.delete': ['删除', 'Delete'],
  'common.all': ['全部', 'All'],
  'common.open': ['未处理', 'Open'],
  'common.anyKind': ['全部类型', 'Any kind'],
  'common.previous': ['上一页', 'Previous'],
  'common.next': ['下一页', 'Next'],
  'common.page': ['第 {page} 页', 'Page {page}'],
  'common.pageOf': ['第 {page} / {pages} 页 · 共 {rows} 行', 'Page {page} of {pages} · {rows} rows'],
  'common.reason': ['原因（记入审计日志）', 'Reason (kept in the audit log)'],
  'common.reasonPlaceholder': ['例如：滥用举报 #123、事故 7', 'e.g. abuse report #123, incident 7'],
  'common.language': ['English', '中文'],
  'common.colon': ['：', ': '],

  'shell.title': ['运营控制台', 'Operator console'],
  'shell.signedInAs': ['当前登录：{email}', 'Signed in as {email}'],
  'shell.backToApp': ['返回应用', 'Back to the app'],
  'shell.signOut': ['退出登录', 'Sign out'],
  'shell.signIn': ['使用邮箱登录', 'Sign in with email'],
  'shell.retry': ['重试', 'Try again'],
  'shell.denied': ['拒绝访问：你的邮箱未被授权使用此控制台。', 'Access denied. Your email is not authorized to use this console.'],
  'shell.expired': ['管理员会话已过期，请使用邮箱验证码重新登录。', 'Your administrator session has expired. Sign in again with your email verification code.'],
  'shell.unverified': ['无法验证管理员会话。请重试，或使用邮箱验证码登录。', 'Could not verify your administrator session. Try again or sign in with your email verification code.'],

  'nav.overview': ['概览', 'Overview'],
  'nav.alerts': ['告警', 'Alerts'],
  'nav.operations': ['操作', 'Operations'],
  'nav.browsers': ['浏览器', 'Browsers'],
  'nav.users': ['用户', 'Users'],
  'nav.pricing': ['定价与毛利', 'Pricing & margin'],
  'nav.aws': ['AWS', 'AWS'],
  'nav.findings': ['资源差异', 'Findings'],
  'nav.limits': ['限额', 'Limits'],
  'nav.audit': ['审计日志', 'Audit log'],

  'overview.alerts': ['未处理告警', 'Open alerts'],
  'overview.findings': ['未处理资源差异', 'Open findings'],
  'overview.unfinished': ['进行中的操作', 'Unfinished operations'],
  'overview.failed24h': ['24 小时内失败', 'Failed in 24 h'],
  'overview.webhooks': ['待处理 Webhook', 'Webhooks pending'],
  'overview.users': ['用户', 'Users'],
  'overview.byStatus': ['浏览器状态', 'Browsers by status'],
  'overview.noBrowsers': ['还没有浏览器。', 'No browsers yet.'],
  'switches.title': ['开关', 'Switches'],
  'switches.freeze': ['冻结新建浏览器', 'Freeze new browsers'],
  'switches.freezeHelp': ['拒绝所有新建请求。熔断器也会自动开启此开关。', 'Creates are refused. The circuit breaker sets this on its own.'],
  'switches.billing': ['从预付余额扣费', 'Charge usage to prepaid balances'],
  'switches.billingHelp': ['开：用量从用户余额扣除，新建或唤醒需要最低余额。关：免费邀请制试用（仍计量用量）。', 'On: usage is taken from each user’s balance, and creating or waking needs the minimum balance. Off: the free invite-only pilot (usage is still metered).'],
  'switches.lastChange': ['上次修改：{reason} · {when}', 'Last change: {reason} · {when}'],

  'alerts.note': ['新告警每 5 分钟发送到告警邮箱和聊天 Webhook。处理后请确认。', 'New alerts are sent to the alert emails and the chat webhook every 5 minutes. Acknowledge once handled.'],
  'alerts.empty': ['没有未处理的告警。', 'No open alerts.'],
  'alerts.ack': ['确认', 'Acknowledge'],
  'alerts.acked': ['已确认 {when}', 'ack {when}'],
  'alerts.pending': ['待发送', 'pending'],
  'col.when': ['时间', 'When'],
  'col.severity': ['级别', 'Severity'],
  'col.source': ['来源', 'Source'],
  'col.alert': ['告警', 'Alert'],
  'col.detail': ['详情', 'Detail'],
  'col.sent': ['已发送', 'Sent'],
  'col.created': ['创建时间', 'Created'],
  'col.kind': ['类型', 'Kind'],
  'col.status': ['状态', 'Status'],
  'col.step': ['步骤', 'Step'],
  'col.attempt': ['尝试次数', 'Attempt'],
  'col.browser': ['浏览器', 'Browser'],
  'col.user': ['用户', 'User'],
  'col.error': ['错误', 'Error'],
  'col.region': ['地区', 'Region'],
  'col.ip': ['IP', 'IP'],
  'col.owner': ['所有者', 'Owner'],
  'col.updated': ['更新时间', 'Updated'],
  'col.email': ['邮箱', 'Email'],
  'col.joined': ['注册时间', 'Joined'],
  'col.balance': ['余额', 'Balance'],
  'col.browsers': ['浏览器', 'Browsers'],
  'col.killSwitch': ['紧急停用', 'Kill switch'],
  'col.resource': ['资源', 'Resource'],
  'col.where': ['位置', 'Where'],
  'col.actor': ['操作者', 'Actor'],
  'col.action': ['动作', 'Action'],
  'col.target': ['对象', 'Target'],
  'col.scope': ['范围', 'Scope'],
  'col.metric': ['指标', 'Metric'],
  'col.limit': ['上限', 'Limit'],
  'col.item': ['项目', 'Item'],
  'col.charged': ['已收费', 'Charged'],
  'col.awsCost': ['估算 AWS 成本', 'Est. AWS cost'],
  'col.margin': ['估算毛利', 'Est. margin'],
  'col.pricesFrom': ['价格来源', 'Prices from'],
  'col.gen': ['代', 'Gen'],
  'col.zone': ['可用区', 'Zone'],
  'col.vm': ['虚拟机', 'VM'],
  'col.volume': ['磁盘', 'Volume'],
  'col.address': ['地址', 'Address'],
  'col.assigned': ['分配时间', 'Assigned'],
  'col.released': ['释放时间', 'Released'],
  'col.attempts': ['尝试次数', 'Attempts'],
  'col.result': ['结果', 'Result'],

  'ops.unfinished': ['进行中', 'Unfinished'],
  'ops.failed': ['失败', 'Failed'],
  'ops.nextTry': ['下次重试 {when}', 'next try {when}'],
  'ops.dialog': ['操作', 'Operation'],
  'ops.journal': ['步骤日志', 'Step journal'],

  'browsers.searchPlaceholder': ['ID、名称、所有者邮箱或 IP', 'Id, name, owner email or IP'],
  'browsers.suspended': ['已停用', 'suspended'],
  'browsers.notFound': ['未找到。', 'Not found.'],
  'browsers.id': ['ID', 'Id'],
  'browsers.status': ['状态', 'Status'],
  'browsers.owner': ['所有者', 'Owner'],
  'browsers.where': ['地区 · IP', 'Region · IP'],
  'browsers.whereValue': ['{region} · {ip} · 可用区 {zone} · 第 {gen} 代', '{region} · {ip} · zone {zone} · generation {gen}'],
  'browsers.agent': ['代理程序', 'Agent'],
  'browsers.agentValue': ['就绪 {ready} · 心跳 {heartbeat} · 观看者 {viewers}', 'ready {ready} · heartbeat {heartbeat} · viewers {viewers}'],
  'browsers.operations': ['操作', 'Operations'],
  'browsers.placements': ['部署记录', 'Placements'],
  'browsers.ipHistory': ['IP 历史', 'IP history'],
  'browsers.auditLink': ['查看此浏览器的审计日志', 'Audit log for this browser'],
  'action.retry': ['重试上次失败的操作', 'Retry last failed operation'],
  'action.retryHelp': ['以相同参数重新执行最近一次失败的启动、休眠、恢复、还原、删除或撤销删除。', 'Runs the latest failed start, stop, recover, restore, delete or undelete again with the same parameters.'],
  'action.recover': ['恢复', 'Recover'],
  'action.recoverHelp': ['在同一地区的另一个可用区新建虚拟机，保留原 IP 和数据。', 'New VM in another zone of the same region, with the same IP and data.'],
  'action.stop': ['休眠', 'Put to sleep'],
  'action.stopHelp': ['正常停止浏览器，保留已保存的数据和 IP。', 'Gracefully stops the browser while keeping its saved data and IP.'],
  'action.suspend': ['停用', 'Suspend'],
  'action.suspendHelp': ['紧急停用：浏览器在一分钟内休眠且无法启动。数据和 IP 保留。', 'Kill switch: the browser sleeps within a minute and cannot start. Data and IP are kept.'],
  'action.unsuspend': ['解除停用', 'Release suspension'],
  'action.unsuspendHelp': ['所有者可以再次启动该浏览器。', 'The owner can start the browser again.'],

  'users.searchPlaceholder': ['邮箱或用户 ID', 'Email or user id'],
  'users.staff': ['员工', 'staff'],
  'users.reset2fa': ['重置两步验证', 'Reset 2FA'],
  'users.balanceHint': ['总额 = 可用 + 冻结的七天押金', 'Total = available + held seven-day deposits'],
  'users.balanceSplit': ['可用 {available} · 冻结 {held}', '{available} available · {held} held'],
  'users.frozen': ['已冻结', 'frozen'],
  'users.ranOut': ['余额耗尽', 'ran out'],
  'users.credit': ['调整余额', 'Credit'],
  'users.unfreeze': ['解除冻结', 'Unfreeze'],
  'users.suspendedCount': ['（{n} 个已停用）', ' ({n} suspended)'],
  'users.releaseAll': ['全部解除停用', 'Release all'],
  'users.suspendAll': ['全部停用', 'Suspend all'],
  'users.suspendTitle': ['停用 {email} 的所有浏览器', 'Suspend every browser of {email}'],
  'users.releaseTitle': ['解除 {email} 所有浏览器的停用', 'Release every browser of {email}'],
  'users.suspendHelp': ['这些浏览器将在一分钟内休眠且无法启动。数据和 IP 保留。', 'They go to sleep within a minute and cannot start. Data and IPs are kept.'],
  'users.creditTitle': ['调整 {email} 的余额', 'Credit or debit {email}'],
  'users.creditHelp': ['将下面的金额（美元，负数为扣除）加到预付余额，用户的记录中显示为平台赠送。', "Adds the amount below (USD; negative to take away) to the prepaid balance. It shows as a credit from us in the user's history."],
  'users.amount': ['金额（美元）', 'Amount (USD)'],
  'users.apply': ['确认', 'Apply'],
  'users.resetTitle': ['重置 {email} 的两步验证', 'Reset two-factor sign-in for {email}'],
  'users.resetHelp': ['用于丢失身份验证器和备用码的用户。请先核实身份（例如登录邮箱和近期付款）。之后登录只需邮箱验证码，并可重新设置身份验证器。', 'For a user who lost their authenticator app and backup codes. Confirm who they are first (for example, from their sign-in email and recent payments). Their next sign-in needs only the email code, and they can set up a new authenticator.'],
  'users.unfreezeTitle': ['解除冻结 {email}', 'Unfreeze {email}'],
  'users.unfreezeHelp': ['解除因付款争议而设置的冻结。余额足够时，用户可再次新建和唤醒浏览器。', 'Lifts the hold placed after a payment dispute. The user can create and wake browsers again if their balance allows.'],

  'findings.note': ['账本与云服务实际资源之间的差异。孤儿资源会被停止并打标签；仅当从未服务过用户时，清理程序会在 24 小时后删除。缺失的资源需要人工决定。', 'Drift between the ledger and the provider. Orphans are stopped and tagged; the reaper removes them after 24 h only if they never served a user. Missing resources need a decision.'],
  'findings.empty': ['没有资源差异。', 'No findings.'],
  'findings.resolved': ['已解决', 'Resolved'],
  'findings.resolve': ['标记已解决', 'Resolve'],
  'findings.resolvedAt': ['已解决 {when}', 'resolved {when}'],
  'findings.resolveTitle': ['标记资源差异已解决', 'Resolve finding'],
  'findings.resolveHelp': ['说明处理方式，例如已由清理程序删除或已接管。', 'Say what was done, e.g. removed by the reaper or adopted.'],

  'audit.target': ['对象，例如 instance:01J…', 'Target, e.g. instance:01J…'],
  'audit.actor': ['操作者前缀，例如 admin:', 'Actor prefix, e.g. admin:'],

  'limits.perUser': ['每位用户最多浏览器数', 'Browsers per user'],
  'limits.perUserHelp': ['用户最多可拥有的浏览器数量，全部可以同时运行，没有单独的同时运行上限。立即生效；已有的浏览器不受影响。单个用户可在下表用 user:<id> / instances 覆盖。', 'How many browsers each user may own; all of them may run at the same time, with no separate running limit. Applies at once; existing browsers are kept. Override one user below with user:<id> / instances.'],
  'limits.note': ['范围：global、region:<id>、user:default（默认值）、user:<id>（单个用户覆盖，优先于套餐）。billing:<id> 来自 Creem，此处只读。', 'Scopes: global, region:<id>, user:default (defaults) and user:<id> (per-user override, wins over the plan). billing:<id> rows come from Creem and are read-only here.'],
  'limits.saveCap': ['保存限额', 'Save cap'],
  'limits.idleMax': ['自动休眠最长时间', 'Longest auto-sleep'],
  'limits.minutes': ['{n} 分钟', '{n} min'],
  'limits.idleMaxHelp': ['用户在浏览器设置中可选的最长「无操作后自动休眠」时间（user:default / idle_timeout_max_s，单位秒）。更长的选项会显示为不可选。空闲时间按运行时间计费，所以更长的上限不会造成亏损，只会让忘记关闭的用户多花钱。立即生效；已选择更长时间的浏览器保持原设置。可在下表用 user:<id> / idle_timeout_max_s 为单个用户覆盖。', 'The longest "Auto-sleep after" users can choose in a browser\'s settings (user:default / idle_timeout_max_s, in seconds); longer choices are shown greyed out. Idle time is billed as running time, so a longer limit never loses money; it only lets a user who forgets a browser spend more. Applies at once; browsers already set longer keep their setting. Override one user below with user:<id> / idle_timeout_max_s.'],
  'limits.neverSleep': ['永不休眠', 'Never sleep'],
  'limits.neverSleepOn': ['已向付费用户提供', 'Offered to paid users'],
  'limits.neverSleepOff': ['未提供', 'Not offered'],
  'limits.neverSleepEnable': ['提供永不休眠', 'Offer Never sleep'],
  'limits.neverSleepDisable': ['停止提供', 'Stop offering'],
  'limits.neverSleepHelp': ['独立于自动休眠上限的开关（user:default / never_sleep，1 或 0）。仅对已充值、可用余额足够 24 小时持续运行的付费浏览器提供，试用浏览器始终不可用。可在下表用 user:<id> / never_sleep 为单个用户覆盖。停止提供不会更改已开启的浏览器。', 'A switch separate from the auto-sleep limit (user:default / never_sleep, 1 or 0). Only paid browsers on topped-up accounts with credit for 24 hours of continuous running can use it; free trial browsers never can. Override one user below with user:<id> / never_sleep. Turning it off does not change browsers that already use it.'],
  'limits.fromCreem': ['来自 Creem', 'from Creem'],
  'limits.deleteTitle': ['删除 {scope} / {metric}', 'Delete {scope} / {metric}'],
  'limits.deleteHelp': ['删除后使用下一级范围（user:<id> → 套餐 → user:default）。', 'Without this row the next scope applies (user:<id> → plan → user:default).'],
  'limits.deleteCap': ['删除限额', 'Delete cap'],

  'pricing.refresh': ['立即刷新价格', 'Refresh prices now'],
  'pricing.refreshed': ['已从 AWS 刷新价格', 'Prices refreshed from AWS'],
  'pricing.month': ['本月（{month}）计量用量', 'This month ({month}), metered usage'],
  'pricing.charged': ['向用户收取', 'Charged to customers'],
  'pricing.cost': ['计量用量的估算 AWS 成本', 'Est. AWS cost of metered usage'],
  'pricing.margin': ['毛利', 'Gross margin'],
  'pricing.topups': ['充值入账（{n} 笔）', 'Top-ups credited ({n})'],
  'pricing.fees': ['估算支付手续费', 'Est. payment fees'],
  'pricing.refunds': ['退款与争议', 'Refunds and disputes'],
  'pricing.credits': ['赠送余额', 'Credits granted'],
  'pricing.note': ['成本按 AWS 公开单价和平台用量估算，并非 AWS 账单；免费额度、AWS 抵扣券和折扣未计入。未结余额：{total}（其中 {negative} 为负数）。', 'Costs use AWS public unit prices and platform usage, not an AWS bill; free tier, AWS credits and discounts are not included. Outstanding balances: {total} (of which {negative} below zero).'],
  'pricing.total': ['合计', 'Total'],
  'pricing.settings': ['用户价格设置', 'Customer price settings'],
  'pricing.markup': ['加价（AWS 成本的 %）', 'Markup (% of AWS cost)'],
  'pricing.minBalance': ['新建/唤醒最低余额（$）', 'Min. balance to create/wake ($)'],
  'pricing.lowBalance': ['低余额提醒（$）', 'Low-balance warning ($)'],
  'pricing.feePct': ['支付手续费（%）', 'Payment fee (%)'],
  'pricing.feeFixed': ['每笔充值固定手续费（$）', 'Payment fee per top-up ($)'],
  'pricing.settingsNote': ['用户价格 = AWS 成本 × 加价 ÷ 100（不低于 100%）。修改仅影响此后的用量。手续费只用于上面的毛利估算。', 'Customer price = AWS cost × markup ÷ 100 (at least 100%). Changes apply to usage from now on. Payment fees are only used for the margin estimate above.'],
  'pricing.perRegion': ['各地区 AWS 成本 → 用户价格', 'AWS cost → customer price, per region'],
  'pricing.regionNote': ['价格超过 12 小时会自动重新读取；没有价格的地区无法新建浏览器。', 'Prices are read again when older than 12 hours; browsers cannot be created in a region without prices.'],
  'pricing.disabled': ['已停用', 'disabled'],
  'pricing.simulated': ['模拟', 'simulated'],
  'pricing.priceList': ['AWS 价格表', 'AWS Price List'],
  'pricing.noPrices': ['无价格', 'no prices'],
  'pricing.confirmTitle': ['修改用户价格', 'Change customer prices'],
  'pricing.confirmHelp': ['加价 {from}% → {to}%。用户立即看到新价格；之前打开的报价会提示“价格已变更”，需重新确认。', 'Markup {from}% → {to}%. Users see the new prices at once; anything they had open is refused with “prices changed” until they review it.'],
  'item.compute': ['运行（每小时）', 'Running (per hour)'],
  'item.ip': ['独享 IP（每小时）', 'Dedicated IP (per hour)'],
  'item.storage': ['存储（每 GB·月）', 'Storage (per GB-month)'],
  'item.transfer': ['出站流量（每 GB）', 'Data out (per GB)'],
  'item.snapshot': ['快照（内部，不收费）', 'Snapshots (internal, not charged)'],

  'aws.sync': ['从 AWS 同步', 'Sync from AWS'],
  'aws.syncQueued': ['已排队同步 AWS', 'AWS synchronization queued'],
  'aws.runtimeAccount': ['运行账号', 'Runtime account'],
  'aws.managementAccount': ['管理账号', 'Management account'],
  'aws.notConnected': ['未连接', 'Not connected'],
  'aws.costMonth': ['本月 AWS 费用', 'AWS cost this month'],
  'aws.costEstimated': ['本月 AWS 费用（AWS 估算）', 'AWS cost this month (AWS estimate)'],
  'aws.orgCost': ['组织本月费用', 'Organization cost this month'],
  'aws.unavailable': ['不可用', 'Unavailable'],
  'aws.credentials': ['访问凭证', 'Credentials'],
  'aws.runtimeSession': ['运行角色会话', 'Runtime role session'],
  'aws.managementSession': ['管理角色会话', 'Management role session'],
  'aws.expiresAt': ['有效期至 {when}，到期前 5 分钟自动续期', 'valid until {when}; renews automatically 5 minutes before expiry'],
  'aws.accessKeyOnly': ['仅使用访问密钥（未配置 AssumeRole，无需续期，也不会自动轮换）', 'access key only (no AssumeRole; nothing to renew, and the key does not rotate)'],
  'aws.notConfigured': ['未配置', 'not configured'],
  'aws.baseKey': ['引导访问密钥', 'Bootstrap access key'],
  'aws.baseKeyNote': ['IAM 用户的访问密钥不会过期，也无法自动轮换：请定期在 Worker 密钥中更换，新密钥在下一次调用时生效。', 'IAM user access keys do not expire and cannot rotate automatically: replace them in the Worker secrets periodically; a new key takes effect on the next invocation.'],
  'aws.lastSync': ['地区检查 {catalog} · 费用检查 {billing}', 'Regions checked {catalog} · Billing checked {billing}'],
  'aws.regions': ['各地区可创建数量', 'New browsers AWS can allocate, per region'],
  'aws.regionsNote': ['可创建数量 = AWS 配额剩余（弹性 IP、按需 vCPU、gp3 存储、网络接口、子网地址）− 已占用名额的浏览器。休眠中的浏览器仍保留名额以便唤醒。数据超过 20 分钟或价格超过 48 小时未更新的地区暂停新建。AWS 物理容量在启动时确认。', 'Available = AWS quota room (Elastic IPs, On-Demand vCPUs, gp3 storage, network interfaces, subnet addresses) − browsers holding a slot. Sleeping browsers keep their slot so they can wake. Regions with quotas older than 20 minutes or prices older than 48 hours take no new browsers. Physical capacity is confirmed at launch.'],
  'aws.launchNote': ['已验证：有浏览器虚拟机在此启动过。已阻止：AWS 拒绝本账号使用该地区的加密密钥（IAM、组织 SCP 或密钥策略），修复后需手动重新开放。已暂停：其他云服务故障，30 分钟后自动恢复。', "Tested: a browser VM started there. Blocked: AWS refused the account's use of the region's encryption key (IAM, an organization SCP or the key policy); reopen it after fixing the cause. Paused: another provider failure; creation resumes by itself after 30 minutes."],
  'aws.col.region': ['地区', 'Region'],
  'aws.col.status': ['状态', 'Status'],
  'aws.col.launches': ['启动情况', 'Launches'],
  'aws.col.available': ['可创建', 'Available'],
  'aws.col.held': ['已占用', 'Held'],
  'aws.col.quotas': ['AWS 配额（已用 / 上限）', 'AWS quotas (used / limit)'],
  'aws.col.cost': ['本月费用', 'Cost this month'],
  'aws.col.sync': ['上次同步', 'Last sync'],
  'aws.prices': ['价格：{when}', 'Prices: {when}'],
  'aws.blocked': ['已阻止', 'Blocked'],
  'aws.paused': ['已暂停', 'Paused'],
  'aws.tested': ['已验证', 'Tested'],
  'aws.untested': ['未验证', 'Not yet tested'],
  'aws.reopen': ['重新开放', 'Reopen'],
  'aws.reopenTitle': ['重新开放 {region} 的新建', 'Reopen {region} for new browsers'],
  'aws.reopenHelp': ['仅在原因已修复后操作，否则下一个新建的浏览器会以同样方式失败。', 'Only after the cause is fixed: the next browser created there fails the same way otherwise.'],
  'aws.reopened': ['地区已重新开放', 'Region reopened'],
  'aws.credits': ['AWS 抵扣券', 'AWS credits'],
  'aws.col.credit': ['抵扣券', 'Credit'],
  'aws.col.remaining': ['剩余 / 估算', 'Remaining / estimated'],
  'aws.col.expires': ['到期', 'Expires'],
  'aws.creditsNote': ['抵扣券有适用服务、到期时间和共享规则，数值直接来自 AWS。', 'Credits have service eligibility, expiry dates and sharing rules; values come directly from AWS.'],

  'error.validation_failed': ['请求无效', 'Invalid request'],
  'error.not_found': ['未找到', 'Not found'],
  'error.invalid_state': ['当前状态下无法执行', 'Not possible in the current state'],
  'error.forbidden': ['没有权限', 'Not allowed'],
  'error.unauthenticated': ['管理员会话已过期', 'Your administrator session has expired'],
  'error.internal': ['出现错误', 'Something went wrong'],
} as const satisfies Record<string, readonly [string, string]>;

export type AdminKey = keyof typeof M;

/** Statuses, kinds and severities shown as pills. Unknown values are shown as they are. */
const TERMS: Record<string, string> = {
  running: '运行中', creating: '创建中', starting: '启动中', stopping: '正在休眠', sleeping: '休眠中', waiting_capacity: '等待容量',
  provider_issue: '云服务故障', needs_attention: '需处理', failed: '失败', deleting: '删除中', purged: '已清除', succeeded: '成功',
  queued: '排队中', pending: '等待中', waiting: '等待中', cancelled: '已取消', current: '当前', building: '构建中', retired: '已退役',
  superseded: '已替换', active: '有效', rejected: '已拒绝', deleted: '已删除', open: '未处理', resolved: '已解决', orphan: '孤儿资源',
  missing: '缺失', critical: '严重', warning: '警告', info: '信息', ready: '就绪', syncing: '同步中', unavailable: '不可用',
  'not-enabled': '未启用', 'not-supported': '不支持', create: '创建', start: '启动', stop: '休眠', recover: '恢复', restore: '还原',
  delete: '删除', undelete: '撤销删除', purge: '清除', resize_volume: '扩容', change_ip: '更换 IP', vm: '虚拟机', volume: '磁盘',
  network_interface: '网络接口', ip: 'IP', snapshot: '快照', 'opt-in-not-required': '默认启用', 'opted-in': '已启用', 'not-opted-in': '未启用',
};

/** Admin API messages, translated where the console knows them. */
const DETAILS: [RegExp, string][] = [
  [/^This region has no open provider failure\.$/, '该地区没有未解决的云服务故障。'],
  [/^AWS Provider service is not configured\.$/, '未配置 AWS 同步服务。'],
  [/^AWS synchronization could not be queued\.$/, '无法排队 AWS 同步。'],
  [/^No failed start, stop, recover, restore, delete or undelete to retry\.$/, '没有可重试的失败操作。'],
  [/^Cannot recover a browser that is (.+)\.$/, '无法恢复状态为 $1 的浏览器。'],
  [/^The engine could not refresh prices\.$/, '引擎无法刷新价格。'],
  [/^limit is required$/, '必须填写上限。'],
  [/^Users have one limit: instances\./, '用户只有一个上限：instances（拥有的浏览器数），全部可以同时运行。'],
  [/^Daily creation limits are no longer supported\./, '不再支持每日新建上限，请改为设置 instances 上限。'],
];

type Vars = Record<string, string | number>;
type Ctx = { locale: AdminLocale; setLocale: (l: AdminLocale) => void; t: (k: AdminKey, vars?: Vars) => string; term: (s: string) => string; errorText: (e: unknown) => string };
const AdminI18n = createContext<Ctx | null>(null);

function initial(): AdminLocale {
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'en') return 'en';
  } catch {
    // Storage blocked: Chinese.
  }
  return 'zh-CN';
}

export function AdminI18nProvider({ children }: { children: ReactNode }) {
  const [locale, setState] = useState<AdminLocale>(initial);
  const setLocale = useCallback((l: AdminLocale) => {
    setState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Not persisted; applies to this tab.
    }
  }, []);
  setAdminLocale(locale);
  document.documentElement.lang = locale;
  const value = useMemo<Ctx>(() => {
    const zh = locale === 'zh-CN';
    const t = (k: AdminKey, vars?: Vars) => {
      let s: string = M[k][zh ? 0 : 1];
      if (vars) for (const [name, v] of Object.entries(vars)) s = s.replaceAll(`{${name}}`, String(v));
      return s;
    };
    const term = (s: string) => (zh ? (TERMS[s] ?? s.replaceAll('_', ' ')) : s.replaceAll('_', ' '));
    const errorText = (e: unknown) => {
      if (!(e instanceof ApiError)) return e instanceof Error && !zh ? e.message : t('error.internal');
      const detail = e.problem.detail;
      if (!zh) return detail ?? e.problem.title;
      const known = detail ? DETAILS.find(([re]) => re.test(detail)) : undefined;
      if (known && detail) return detail.replace(known[0], known[1]);
      const key = `error.${e.problem.type}` as AdminKey;
      const title = key in M ? t(key) : t('error.internal');
      return detail ? `${title}：${detail}` : title;
    };
    return { locale, setLocale, t, term, errorText };
  }, [locale, setLocale]);
  return <AdminI18n.Provider value={value}>{children}</AdminI18n.Provider>;
}

export function useT() {
  const v = useContext(AdminI18n);
  if (!v) throw new Error('useT outside AdminI18nProvider');
  return v;
}
