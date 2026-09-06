CREATE TABLE `cms_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cms_sessions_expires_at` ON `cms_sessions` (`expires_at`);
