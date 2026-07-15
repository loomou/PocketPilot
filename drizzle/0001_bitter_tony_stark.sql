CREATE TABLE `access_tokens` (
	`created_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`revoked_at` integer,
	`secret_envelope` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `access_tokens_device_id_index` ON `access_tokens` (`device_id`);--> statement-breakpoint
CREATE INDEX `access_tokens_expires_at_index` ON `access_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`created_at` integer NOT NULL,
	`device_id` text,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`pairing_id` text,
	`purpose` text NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pairing_id`) REFERENCES `pairings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_challenges_device_id_index` ON `auth_challenges` (`device_id`);--> statement-breakpoint
CREATE INDEX `auth_challenges_expires_at_index` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
ALTER TABLE `pairings` ADD `device_display_name` text;--> statement-breakpoint
ALTER TABLE `pairings` ADD `device_public_key` text;