/**
 * 手工维护的环境类型合并（见 .trellis/spec/backend/env-config.md）。
 *
 * `wrangler types` 只能从 wrangler.jsonc 推导绑定类型（如 HODOR_DB），
 * 读不到 Secret 与面板变量，因此这 9 个变量在这里手工声明。
 *
 * 注意：选填变量未配置时运行时为 undefined（binding 缺席），
 * 消费方必须自行处理默认值，不得假设字段恒为字符串。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      /** 【必填 Secret】Bot token，Worker → Telegram 调用凭证，永不进 URL / 日志 */
      TELEGRAM_BOT_TOKEN: string;
      /** 【必填 Secret】setWebhook 的官方 secret_token，update 回调头校验用 */
      TELEGRAM_WEBHOOK_SECRET: string;
      /** 【必填 Secret】管理端点凭证，作为 URL 路径段使用（/setwebhook/<ADMIN_SECRET>） */
      ADMIN_SECRET: string;
      /** 【必填 Var】客服超级群 chat_id（-100 开头） */
      SUPPORT_CHAT_ID: string;
      /** 【必填 Var】管理员 Telegram 用户 ID，逗号分隔 */
      ADMIN_IDS: string;
      /** 【选填 Var】每用户每分钟转发上限，缺省 20 */
      MAX_MESSAGES_PER_MINUTE?: string;
      /** 【选填 Var】验证有效期（小时），缺省 0 = 永久 */
      VERIFY_TTL_HOURS?: string;
      /** 【选填 Var】同一条 update 处理失败的最大重试次数，缺省 3 */
      MAX_ATTEMPTS?: string;
      /** 【选填 Var】自定义欢迎语文案，支持换行（字面 \n 解释为换行）；缺省用内置默认文案 */
      WELCOME_TEXT?: string;
      /** 【选填 Var】Cloudflare Turnstile Widget 的公开 Site Key（可公开，非机密）；与 TURNSTILE_SECRET_KEY 成对配置 */
      TURNSTILE_SITE_KEY?: string;
      /** 【选填 Secret】Cloudflare Turnstile 服务端校验密钥；仅服务端 Siteverify 使用，绝不进页面 / 日志 / 诊断 */
      TURNSTILE_SECRET_KEY?: string;
      /** 【选填 Var】验证页面的固定公网地址（HTTPS origin）；缺省按 webhook 请求 origin 推导 */
      PUBLIC_BASE_URL?: string;
      /** 【选填 Var】自定义敏感词列表，逗号分隔，支持 re:正则表达式（如：兼职,代发,re:usdt.*承兑） */
      SPAM_KEYWORDS?: string;
      /** 【选填 Var】是否启用内置 Telegram 黑灰产高频敏感词库，默认 true；填 false 关闭 */
      SPAM_PRESET_ENABLED?: string;
      /** 【选填 Var】识别为黑灰产/广告后是否自动拉黑封禁用户，默认 true；填 false 仅静默丢弃不封禁 */
      SPAM_AUTO_BAN?: string;
      /** 【选填 Secret】AI 接口密钥（支持 DeepSeek / 硅基流动 / OpenAI 等兼容接口）；不填则仅启用敏感词拦截 */
      AI_API_KEY?: string;
      /** 【选填 Var】AI 接口 Base URL，缺省 https://api.deepseek.com/v1 */
      AI_BASE_URL?: string;
      /** 【选填 Var】AI 模型名称，缺省 deepseek-chat */
      AI_MODEL?: string;
    }
  }
}

// 使本文件成为 module，避免全局污染
export type {};
