-- Promotions: tasks that teach the product and pay a reward into the prepaid balance. Operators
-- configure them in the console: the wording (English and Chinese), what counts as done (a
-- criterion and a target), the reward, when it runs and how many accounts may earn it.
CREATE TABLE `promotion_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`action_url` text,
	`criterion` text NOT NULL,
	`target` integer NOT NULL,
	`reward_micros` integer NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`requires_topup` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`max_completions` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
-- One row per account and task, written once when the task is done; `credited_at` is set after the
-- reward reaches the balance, so a failed credit is retried by the next sweep.
CREATE TABLE `promotion_completions` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`progress` integer NOT NULL,
	`reward_micros` integer NOT NULL,
	`completed_at` integer NOT NULL,
	`credited_at` integer,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `promotion_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `promotion_completions_user_idx` ON `promotion_completions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `promotion_completions_pending_idx` ON `promotion_completions` (`credited_at`);
--> statement-breakpoint
-- The first task: create a browser and keep it running for 20 minutes in total, for $5 of credit.
INSERT OR IGNORE INTO `promotion_tasks` (`id`, `title`, `description`, `action_url`, `criterion`, `target`, `reward_micros`, `enabled`, `requires_topup`, `sort_order`, `created_at`, `updated_at`, `updated_by`) VALUES (
	'first-browser-20-minutes',
	'{"en":"Run your first browser for 20 minutes","zh-CN":"让你的第一个浏览器运行 20 分钟"}',
	'{"en":"Create a browser and use it for a total of 20 minutes, in one go or over several sessions. $5 of credit is added to your balance as soon as you finish.","zh-CN":"创建一个浏览器，累计使用满 20 分钟（可一次用完，也可分多次）。完成后，$5 额度会立即加入你的余额。"}',
	'/browsers/new',
	'browser_running_minutes',
	20,
	5000000,
	1,
	0,
	0,
	unixepoch() * 1000,
	unixepoch() * 1000,
	'migration'
);
