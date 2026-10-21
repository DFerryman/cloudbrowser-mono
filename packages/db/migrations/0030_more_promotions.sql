-- More promotions (console → Promotions). Rewards stay between $1 and $10, each task is limited to a
-- few accounts, and every task but two-step verification needs a paid top-up first. Rewards from
-- top-up tasks are also capped per account at 50% of its paid top-ups (contracts
-- PROMOTION_TOPUP_SHARE_PERCENT), so promotions never fund an account that does not pay.
-- Counted from this release: earlier activity does not pay out at once. Operators can edit, pause
-- or delete any of them in the console.
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'turn-on-two-step',
	'{"en": "Turn on two-step verification", "zh-CN": "开启两步验证"}',
	'{"en": "Protect your account: go to Account and turn on two-step verification with an authenticator app. $1 of credit is added as soon as it is on.", "zh-CN": "保护你的账户：在「账户」页用验证器应用开启两步验证。开启后立即获得 $1 额度。"}',
	'/account',
	'two_factor_enabled',
	1,
	1000000,
	1,
	0,
	10,
	unixepoch() * 1000,
	NULL,
	100,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'topup-10-bonus',
	'{"en": "Add $10 of credit", "zh-CN": "充值满 $10"}',
	'{"en": "Top up a total of $10 or more (one top-up or several, refunds excluded). $2 of bonus credit is added on top.", "zh-CN": "累计充值 $10 或以上（可一次或多次，退款不计）。额外赠送 $2 额度。"}',
	'/billing#top-up',
	'topup_usd',
	10,
	2000000,
	1,
	1,
	20,
	unixepoch() * 1000,
	NULL,
	100,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'add-a-passkey',
	'{"en": "Add a passkey", "zh-CN": "添加通行密钥"}',
	'{"en": "Add a passkey to your account (Account → Passkeys) to confirm sensitive actions with your fingerprint, face or security key.", "zh-CN": "在「账户 → 通行密钥」添加一个通行密钥，之后可用指纹、面容或安全密钥确认敏感操作。"}',
	'/account',
	'passkeys_added',
	1,
	1000000,
	1,
	1,
	30,
	unixepoch() * 1000,
	NULL,
	100,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'three-active-days',
	'{"en": "Use your browser on 3 different days", "zh-CN": "在 3 个不同的日子使用浏览器"}',
	'{"en": "Open a browser and use it for at least 5 minutes on 3 different days (UTC). The days do not need to be in a row.", "zh-CN": "在 3 个不同的日子（UTC）打开浏览器，每天累计使用至少 5 分钟。不需要连续。"}',
	'/browsers',
	'active_days',
	3,
	2000000,
	1,
	1,
	40,
	unixepoch() * 1000,
	NULL,
	80,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'two-hour-session',
	'{"en": "Spend 2 hours in one browser", "zh-CN": "在一个浏览器里使用 2 小时"}',
	'{"en": "Use one browser for 2 hours in total: log in to the sites you work with, keep its tabs and come back to it. Time counts while the browser is open on your screen.", "zh-CN": "在同一个浏览器中累计使用 2 小时：登录你常用的网站、保留标签页，下次回来继续用。浏览器画面在你屏幕上打开期间计时。"}',
	'/browsers',
	'browser_used_minutes',
	120,
	3000000,
	1,
	1,
	50,
	unixepoch() * 1000,
	NULL,
	60,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'try-a-second-region',
	'{"en": "Run browsers in two regions", "zh-CN": "在两个地区运行浏览器"}',
	'{"en": "Create browsers in two different regions to get local IP addresses in both places (one at a time is fine: a deleted browser still counts).", "zh-CN": "在两个不同地区各创建一个浏览器，获得两地的本地 IP（可先后创建，已删除的浏览器也算）。"}',
	'/browsers/new',
	'regions_used',
	2,
	2000000,
	1,
	1,
	60,
	unixepoch() * 1000,
	NULL,
	50,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'grow-your-storage',
	'{"en": "Give a browser more storage", "zh-CN": "为浏览器扩容存储"}',
	'{"en": "Open a browser''s Storage tab and grow its disk. Larger storage keeps more downloads, profiles and cache. The reward is added once the upgrade finishes.", "zh-CN": "打开浏览器的「存储」页并扩大磁盘，可保存更多下载、配置文件和缓存。扩容完成后发放奖励。"}',
	'/browsers',
	'storage_resized',
	1,
	2000000,
	1,
	1,
	70,
	unixepoch() * 1000,
	NULL,
	40,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'weekly-regular',
	'{"en": "Use your browser on 7 different days", "zh-CN": "在 7 个不同的日子使用浏览器"}',
	'{"en": "Make your cloud browser part of your routine: use it for at least 5 minutes on 7 different days (UTC).", "zh-CN": "让云浏览器成为日常工具：在 7 个不同的日子（UTC）各累计使用至少 5 分钟。"}',
	'/browsers',
	'active_days',
	7,
	5000000,
	1,
	1,
	80,
	unixepoch() * 1000,
	NULL,
	40,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'ten-hours-of-browsing',
	'{"en": "Browse for 10 hours this season", "zh-CN": "本季累计使用 10 小时"}',
	'{"en": "Use your browsers for 10 hours in total, across any browsers and sessions, before the end of the year.", "zh-CN": "年底前在任意浏览器中累计使用 10 小时（可分多个浏览器、多次完成）。"}',
	'/browsers',
	'live_view_minutes',
	600,
	6000000,
	1,
	1,
	90,
	unixepoch() * 1000,
	1798761600000,
	30,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'usage-15',
	'{"en": "Reach $15 of paid usage", "zh-CN": "实付用量达到 $15"}',
	'{"en": "Run your browsers until $15 of usage has been charged to your balance. $3 comes back to you as credit.", "zh-CN": "使用浏览器，直到余额实际扣费达到 $15，返还 $3 额度。"}',
	'/browsers',
	'paid_usage_usd',
	15,
	3000000,
	1,
	1,
	100,
	unixepoch() * 1000,
	NULL,
	40,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'three-topups',
	'{"en": "Top up three times", "zh-CN": "充值三次"}',
	'{"en": "Make three separate top-ups (refunded ones do not count). Thanks for sticking with us: $4 of bonus credit.", "zh-CN": "完成三次独立的充值（已退款的不计）。感谢长期支持，赠送 $4 额度。"}',
	'/billing#top-up',
	'topups_count',
	3,
	4000000,
	1,
	1,
	110,
	unixepoch() * 1000,
	NULL,
	30,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'usage-40',
	'{"en": "Power user: $40 of paid usage", "zh-CN": "重度用户：实付用量达到 $40"}',
	'{"en": "Reach $40 of usage charged to your balance before the end of the year. $8 comes back to you as credit.", "zh-CN": "年底前余额实际扣费达到 $40，返还 $8 额度。"}',
	'/browsers',
	'paid_usage_usd',
	40,
	8000000,
	1,
	1,
	120,
	unixepoch() * 1000,
	1798761600000,
	20,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `starts_at`, `ends_at`, `max_completions`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'twenty-active-days',
	'{"en": "Use your browser on 20 different days", "zh-CN": "在 20 个不同的日子使用浏览器"}',
	'{"en": "Our most dedicated users: use your browsers for at least 5 minutes on 20 different days (UTC).", "zh-CN": "致最忠实的用户：在 20 个不同的日子（UTC）各累计使用至少 5 分钟。"}',
	'/browsers',
	'active_days',
	20,
	10000000,
	1,
	1,
	130,
	unixepoch() * 1000,
	NULL,
	15,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
