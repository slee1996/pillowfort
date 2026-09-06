declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    IMAGES: ImagesBinding;
    CMS_ADMIN_PASSWORD: string;
    CMS_ADMIN_NAME?: string;
    CMS_LOGIN_RATE_LIMITER: RateLimit;
  }
}
