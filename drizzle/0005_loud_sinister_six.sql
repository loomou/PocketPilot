ALTER TABLE `tasks` ADD `active_turn_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `native_conversation_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `native_session_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_live_provider_conversation_unique` ON `tasks` (`provider`,`native_conversation_id`) WHERE "tasks"."native_conversation_id" is not null and "tasks"."state" <> 'terminal';