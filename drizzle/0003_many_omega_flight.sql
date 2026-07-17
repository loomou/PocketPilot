PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`created_at` integer NOT NULL,
	`initial_cwd` text NOT NULL,
	`interrupted_at` integer,
	`model` text,
	`origin` text DEFAULT 'pocketpilot' NOT NULL,
	`permission_mode` text,
	`sdk_session_id` text,
	`state` text NOT NULL,
	`terminal_at` integer,
	`updated_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("created_at", "initial_cwd", "interrupted_at", "model", "origin", "permission_mode", "sdk_session_id", "state", "terminal_at", "updated_at", "id") SELECT "created_at", "initial_cwd", "interrupted_at", "model", 'pocketpilot', "permission_mode", "sdk_session_id", "state", "terminal_at", "updated_at", "id" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_state_index` ON `tasks` (`state`);--> statement-breakpoint
UPDATE `tasks`
SET `state` = 'terminal', `terminal_at` = COALESCE(`terminal_at`, `updated_at`)
WHERE `id` IN (
	SELECT `id`
	FROM (
		SELECT
			`id`,
			ROW_NUMBER() OVER (
				PARTITION BY `sdk_session_id`
				ORDER BY `updated_at` DESC, `created_at` DESC, `id` DESC
			) AS `owner_rank`
		FROM `tasks`
		WHERE `sdk_session_id` IS NOT NULL AND `state` <> 'terminal'
	)
	WHERE `owner_rank` > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_live_sdk_session_id_unique` ON `tasks` (`sdk_session_id`) WHERE "tasks"."sdk_session_id" is not null and "tasks"."state" <> 'terminal';
