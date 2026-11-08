/**
 * 入站反垃圾管线（敏感词屏蔽 + AI 黑灰产/广告智能识别）：
 *
 * 设计目标：
 * 1. 一旦识别为黑灰产 / 推广引流 / 商业广告，直接拦截（blocked: true），绝不放行、绝不让客服看到。
 * 2. 全字段扫描：同时检测发送者昵称（first_name / last_name / username）与消息正文（text / 媒体 caption）。
 * 3. 防混淆归一化：全角转半角（NFKC）、去零宽字符、去拆字间隔符（如「跑_分」「兼 职」）。
 * 4. 双源词库：内置 Telegram 黑灰产高频预设词库 + 环境变量 SPAM_KEYWORDS + D1 settings 动态词库（支持 /kwadd 命令管理）。
 * 5. AI 判定：支持任意 OpenAI 兼容接口（DeepSeek / 硅基流动 / OpenAI / Gemini 等），异常或超时时 fail-open 避免卡死正常消息。
 */
import type { ContentPayload } from "./content";

export interface SpamCheckResult {
  blocked: boolean;
  reason?: string;
}

const SETTINGS_KEYWORDS_KEY = "spam_keywords";

/**
 * 内置 Telegram 中文黑灰产 / 推广高频敏感词库（可通过 SPAM_PRESET_ENABLED=false 关闭）
 */
export const BUILTIN_SPAM_KEYWORDS: readonly string[] = [
  // 跑分 / 洗钱 / 资金盘 / 换汇黑产
  "跑分",
  "车队",
  "白资",
  "黑资",
  "洗钱",
  "承兑",
  "u商",
  "收u",
  "出u",
  "万u",
  "代付",
  "代收代付",
  "码商",
  "卡商",
  "四件套",
  "银行卡收购",
  "公户",
  "对公账户",
  "trx能量",
  "能量闪兑",
  // TG 灰产营销 / 协议号 / 拉人 / 群发
  "代发",
  "群发",
  "强拉",
  "拉人",
  "炒群",
  "协议号",
  "直登号",
  "tdata",
  "飞机号",
  "批发号",
  "接码",
  "轰炸机",
  "短信轰炸",
  "呼死你",
  "克隆群",
  "监听机器人",
  // 社工 / 查档 / 盗U / 木马
  "社工库",
  "查档",
  "开盒",
  "查开房",
  "查流水",
  "查定位",
  "盗u",
  "授权秒u",
  "远控",
  // 色情 / 招嫖 / 裸聊诈骗
  "外围",
  "修车",
  "楼凤",
  "全国空降",
  "同城约",
  "同城上门",
  "包夜",
  "嫩模",
  "学生妹",
  "资源群",
  "看片群",
  // 兼职刷单 / 博彩 / 灰产招聘
  "刷单",
  "兼职日结",
  "日入过千",
  "足不出户",
  "狗推",
  "盘口",
  "百家乐",
  "六合彩",
  "时时彩",
  "博彩",
  "体育投注",
  // 典型个人简介引流话术
  "看简介",
  "看主页",
  "点击头像看",
  "业务看简介",
  "需要看简介",
];

/**
 * 文本防混淆归一化：
 * - NFKC 全角转半角（如 ＵＳＤＴ → USDT）
 * - 移除零宽字符
 * - 移除常见拆字干扰符（空格、下划线、点、横杠、星号、斜杠等）
 * - 统一转小写
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\s_*~`|\-./\\,，。、！!？?：:;；"'“”‘’()（）[\]【】<>《》+]+/g, "")
    .toLowerCase();
}

/**
 * 读取 D1 数据库 settings 表中动态配置的敏感词
 */
export async function getDbSpamKeywords(db: D1Database): Promise<string[]> {
  try {
    const row = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(SETTINGS_KEYWORDS_KEY)
      .first<{ value: string }>();
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    }
  } catch (err) {
    console.warn("[antispam] 读取 D1 spam_keywords 失败：", err);
  }
  return [];
}

/**
 * 更新 D1 数据库 settings 表中的动态敏感词（供管理命令 /kwadd /kwdel /kwclear 使用）
 */
export async function updateDbSpamKeywords(
  db: D1Database,
  updater: (current: string[]) => string[],
): Promise<string[]> {
  const current = await getDbSpamKeywords(db);
  const next = Array.from(
    new Set(
      updater(current)
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  );
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(SETTINGS_KEYWORDS_KEY, JSON.stringify(next))
    .run();
  return next;
}

/**
 * 汇总当前生效的全部敏感词：内置预设（可选） + 环境变量 SPAM_KEYWORDS + D1 动态词库
 */
export async function getAllActiveKeywords(env: Cloudflare.Env): Promise<string[]> {
  const presetEnabled = env.SPAM_PRESET_ENABLED !== "false";
  const envWords = (env.SPAM_KEYWORDS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  const dbWords = await getDbSpamKeywords(env.HODOR_DB);

  return Array.from(
    new Set([
      ...(presetEnabled ? BUILTIN_SPAM_KEYWORDS : []),
      ...envWords,
      ...dbWords,
    ]),
  );
}

/**
 * 匹配敏感词：支持 `re:<正则表达式>` 与普通词（自动防拆字归一化匹配）
 */
export function matchSpamKeyword(rawText: string, keywords: readonly string[]): string | null {
  if (!rawText.trim() || keywords.length === 0) return null;
  const normalizedText = normalizeForMatch(rawText);

  for (const kw of keywords) {
    const trimmed = kw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("re:")) {
      try {
        const regex = new RegExp(trimmed.slice(3), "i");
        if (regex.test(rawText) || regex.test(normalizedText)) {
          return trimmed;
        }
      } catch {
        // 忽略非法正则
      }
    } else {
      const normKw = normalizeForMatch(trimmed);
      if (normKw && normalizedText.includes(normKw)) {
        return trimmed;
      }
    }
  }
  return null;
}

/**
 * 调用 OpenAI 兼容接口（DeepSeek / 硅基流动 / OpenAI / Gemini 等）判定是否为黑灰产或广告
 */
async function detectSpamWithAI(
  env: Cloudflare.Env,
  senderProfile: string,
  messageContent: string,
): Promise<SpamCheckResult> {
  const apiKey = env.AI_API_KEY?.trim();
  if (!apiKey) return { blocked: false };

  const baseUrl = (env.AI_BASE_URL?.trim() || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const model = env.AI_MODEL?.trim() || "deepseek-chat";

  const systemPrompt = `你是一个严格的 Telegram 私聊反垃圾与黑灰产拦截器。
请判断以下用户的「昵称/用户名」及「消息内容」是否属于以下任意一类：
1. 黑灰产广告（跑分、洗钱、白资黑资、USDT/TRX换汇承兑、买卖银行卡/四件套/对公户、查档开盒、社工库、盗U木马）
2. 营销推广与灰产工具（Telegram代发、群发、强拉、炒群、买号/协议号/直登号、接码、短信轰炸）
3. 色情招嫖（外围、修车、同城约、空降、资源群、裸聊）
4. 博彩与诈骗（兼职刷单、日结、博彩、百家乐、体育盘口、杀猪盘引流）
5. 诱导看简介/看主页/加群的商业推销或垃圾广告

判断原则：
- 一旦识别属于上述垃圾广告或黑灰产（哪怕是隐晦谐音、试探性黑话、或昵称带广告），必须判定为拦截（"spam": true）。
- 正常的日常问候（如“你好”、“在吗”）、正常技术/生活/业务咨询判定为放行（"spam": false）。

请严格只输出 JSON 格式，不要输出任何额外文字：
{"spam": true或false, "reason": "简短原因"}`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `发送者资料：${senderProfile}\n消息内容：${messageContent.slice(0, 1000)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(`[antispam] AI 接口响应非 200 (${response.status})，放行处理`);
      return { blocked: false };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content?.trim() ?? "";
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { blocked: false };

    const parsed = JSON.parse(jsonMatch[0]) as { spam?: boolean; reason?: string };
    if (parsed.spam === true) {
      return {
        blocked: true,
        reason: `AI 判定黑灰产/广告（${parsed.reason ?? "违规内容"}）`,
      };
    }
    return { blocked: false };
  } catch (err) {
    console.warn("[antispam] AI 判定超时或网络异常，fail-open 放行：", err);
    return { blocked: false };
  }
}

/**
 * 入站反垃圾总入口：先跑敏感词，未命中再跑 AI
 *
 * 隐私安全边界：
 * - 仅接收「陌生来信者」的显示昵称与当前单条文本，绝不读取、绝不携带管理员（你）的 ID、昵称、发言记录、Bot Token 或客服群信息。
 * - 当 skipAi=true（例如管理员已回复过该用户，进入熟人对话阶段）时，完全跳过外部 AI 调用，防止对方在对话中复述你的话被发往 AI。
 */
export async function evaluateInboundSpam(
  env: Cloudflare.Env,
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  payload: ContentPayload,
  options: { skipAi?: boolean } = {},
): Promise<SpamCheckResult> {
  const senderProfile = [
    from.first_name?.trim(),
    from.last_name?.trim(),
  ]
    .filter(Boolean)
    .join(" ");

  const messageText = (payload.text ?? payload.caption ?? "").trim();
  const fullScanText = `${senderProfile}\n${from.username ?? ""}\n${messageText}`.trim();

  if (!fullScanText) return { blocked: false };

  // 1. 本地敏感词检测（100% 在你自己的 Cloudflare Worker 内存里完成，零外部网络请求）
  const keywords = await getAllActiveKeywords(env);
  const hit = matchSpamKeyword(fullScanText, keywords);
  if (hit !== null) {
    return {
      blocked: true,
      reason: `命中敏感词「${hit}」`,
    };
  }

  // 2. AI 智能识别（仅当未跳过 AI、配置了 AI_API_KEY 且有文本/昵称时）
  if (!options.skipAi && (messageText.length > 0 || senderProfile.length > 0)) {
    return detectSpamWithAI(env, senderProfile, messageText || "（纯媒体消息，无文字）");
  }

  return { blocked: false };
}
