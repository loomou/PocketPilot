CREATE TABLE `agent_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_records` (
	`device_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`operation` text NOT NULL,
	`result` text NOT NULL,
	`task_id` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_records_occurred_at_index` ON `audit_records` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `device_credentials` (
	`created_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` integer NOT NULL,
	`secret_envelope` text NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_credentials_device_id_index` ON `device_credentials` (`device_id`);--> statement-breakpoint
CREATE INDEX `device_credentials_superseded_at_index` ON `device_credentials` (`superseded_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`created_at` integer NOT NULL,
	`display_name` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `devices_revoked_at_index` ON `devices` (`revoked_at`);--> statement-breakpoint
CREATE TABLE `event_overflow` (
	`byte_length` integer NOT NULL,
	`created_at` integer NOT NULL,
	`cursor` integer NOT NULL,
	`payload_envelope` text NOT NULL,
	`task_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `cursor`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `operation_results` (
	`created_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`operation_id` text NOT NULL,
	`result_json` text NOT NULL,
	PRIMARY KEY(`device_id`, `operation_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `operation_results_expires_at_index` ON `operation_results` (`expires_at`);--> statement-breakpoint
CREATE TABLE `pairings` (
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`device_id` text,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`secret_envelope` text NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pairings_expires_at_index` ON `pairings` (`expires_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`created_at` integer NOT NULL,
	`initial_cwd` text NOT NULL,
	`interrupted_at` integer,
	`model` text,
	`permission_mode` text NOT NULL,
	`sdk_session_id` text,
	`state` text NOT NULL,
	`terminal_at` integer,
	`updated_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_state_index` ON `tasks` (`state`);