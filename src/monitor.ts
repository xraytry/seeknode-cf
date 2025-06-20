import { Hono } from 'hono'
import { Bot } from 'grammy'

// 定义环境变量类型
interface Env {
  BOT_TOKEN: string
  DB: D1Database
}

// RSS帖子接口类型
interface RSSPost {
  id: string
  title: string
  description: string
  pubDate: string
  category: string
  creator: string
}

// 数据库中的帖子类型
interface DBPost {
  id: number
  post_id: number
  title: string
  content: string
  pub_date: string
  category: string
  creator: string
  is_push: number
  created_at: string
}

// 用户信息接口
interface User {
  id: number
  chat_id: number
  username?: string
  first_name?: string
  last_name?: string
  max_sub: number
  is_active: number
}

// 关键词订阅接口
interface KeywordSub {
  id: number
  user_id: number
  keywords_count: number
  keyword1: string
  keyword2?: string
  keyword3?: string
  is_active: number
}

// 创建监控应用实例
const monitor = new Hono<{ Bindings: Env }>()

// 解析RSS XML数据
function parseRSSXML(xmlText: string): RSSPost[] {
  try {
    const posts: RSSPost[] = []
    
    // 使用正则表达式提取RSS项目
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    const items = xmlText.match(itemRegex) || []
    
    items.forEach((item, index) => {
      // 提取各个字段
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/)
      const linkMatch = item.match(/<link>(.*?)<\/link>/)
      const descriptionMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/)
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/)
      const categoryMatch = item.match(/<category><!\[CDATA\[(.*?)\]\]><\/category>/) || item.match(/<category>(.*?)<\/category>/)
      const creatorMatch = item.match(/<dc:creator><!\[CDATA\[(.*?)\]\]><\/dc:creator>/) || item.match(/<dc:creator>(.*?)<\/dc:creator>/)
      
      // 从链接中提取ID
      const link = linkMatch ? linkMatch[1] : ''
      const idMatch = link.match(/post-(\d+)-/)
      
      const post: RSSPost = {
        id: idMatch ? idMatch[1] : `item-${index}`,
        title: titleMatch ? titleMatch[1].trim() : '无标题',
        description: descriptionMatch ? descriptionMatch[1].trim() : '',
        pubDate: pubDateMatch ? pubDateMatch[1].trim() : '',
        category: categoryMatch ? categoryMatch[1].trim() : '未分类',
        creator: creatorMatch ? creatorMatch[1].trim() : '未知作者'
      }
      
      posts.push(post)
    })
    
    return posts
  } catch (error) {
    console.error('解析RSS失败:', error)
    return []
  }
}

// 获取RSS数据
async function fetchRSSData(): Promise<RSSPost[]> {
  try {
    const response = await fetch('https://rss.nodeseek.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.nodeseek.com/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    })
    
    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status} - ${response.statusText}`)
    }
    
    const xmlText = await response.text()
    return parseRSSXML(xmlText)
  } catch (error) {
    console.error('获取RSS数据失败:', error)
    return []
  }
}

// 获取所有活跃用户
async function getActiveUsers(db: D1Database): Promise<User[]> {
  try {
    const result = await db.prepare('SELECT * FROM users WHERE is_active = 1').all()
    return result.results as unknown as User[]
  } catch (error) {
    console.error('获取用户失败:', error)
    return []
  }
}

// 获取用户的关键词订阅
async function getUserKeywords(db: D1Database, userId: number): Promise<KeywordSub[]> {
  try {
    const result = await db.prepare('SELECT * FROM keywords_sub WHERE user_id = ? AND is_active = 1')
      .bind(userId)
      .all()
    return result.results as unknown as KeywordSub[]
  } catch (error) {
    console.error('获取用户关键词失败:', error)
    return []
  }
}

// 保存RSS帖子到数据库
async function savePostsToDatabase(db: D1Database, posts: RSSPost[]): Promise<number> {
  let savedCount = 0
  
  try {
    for (const post of posts) {
      // 检查帖子是否已存在
      const existing = await db.prepare('SELECT id FROM posts WHERE post_id = ?')
        .bind(parseInt(post.id))
        .first()
      
      if (!existing) {
        // 插入新帖子
        await db.prepare(`
          INSERT INTO posts (post_id, title, content, pub_date, category, creator, is_push)
          VALUES (?, ?, ?, ?, ?, ?, 0)
        `).bind(
          parseInt(post.id),
          post.title,
          post.description,
          post.pubDate,
          post.category,
          post.creator
        ).run()
        
        savedCount++
        console.log(`保存新帖子: ${post.title} (ID: ${post.id})`)
      }
    }
  } catch (error) {
    console.error('保存帖子到数据库失败:', error)
  }
  
  return savedCount
}

// 从数据库获取待推送的帖子
async function getUnpushedPosts(db: D1Database, limit: number = 50): Promise<DBPost[]> {
  try {
    const result = await db.prepare(`
      SELECT * FROM posts 
      WHERE is_push = 0 
      ORDER BY created_at DESC 
      LIMIT ?
    `).bind(limit).all()
    
    return result.results as unknown as DBPost[]
  } catch (error) {
    console.error('获取待推送帖子失败:', error)
    return []
  }
}

// 标记帖子为已推送
async function markPostAsPushed(db: D1Database, postId: number): Promise<void> {
  try {
    await db.prepare('UPDATE posts SET is_push = 1 WHERE post_id = ?')
      .bind(postId)
      .run()
  } catch (error) {
    console.error('标记帖子为已推送失败:', error)
  }
}

// 检查是否已经发送过通知
async function isAlreadySent(db: D1Database, chatId: number, postId: number): Promise<boolean> {
  try {
    const result = await db.prepare('SELECT id FROM push_logs WHERE chat_id = ? AND post_id = ?')
      .bind(chatId, postId)
      .first()
    return !!result
  } catch (error) {
    console.error('检查发送记录失败:', error)
    return false
  }
}

// 记录推送日志
async function logPush(db: D1Database, userId: number, chatId: number, postId: number, subId: number, status: number, errorMessage?: string): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO push_logs (user_id, chat_id, post_id, sub_id, push_status, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(userId, chatId, postId, subId, status, errorMessage || null).run()
  } catch (error) {
    console.error('记录推送日志失败:', error)
  }
}

// 关键词匹配函数
function matchKeywords(post: DBPost, keywords: KeywordSub): boolean {
  const searchText = `${post.title} ${post.content} ${post.category} ${post.creator}`.toLowerCase()
  
  const keyword1 = keywords.keyword1?.toLowerCase()
  const keyword2 = keywords.keyword2?.toLowerCase()
  const keyword3 = keywords.keyword3?.toLowerCase()
  
  // 检查第一个关键词（必须匹配）
  if (!keyword1 || !searchText.includes(keyword1)) {
    return false
  }
  
  // 如果只有一个关键词，直接返回true
  if (keywords.keywords_count === 1) {
    return true
  }
  
  // 检查第二个关键词
  if (keywords.keywords_count === 2) {
    return keyword2 ? searchText.includes(keyword2) : false
  }
  
  // 检查第三个关键词
  if (keywords.keywords_count === 3) {
    return keyword2 && keyword3 ? 
      searchText.includes(keyword2) && searchText.includes(keyword3) : false
  }
  
  return false
}

// 发送Telegram消息
async function sendTelegramMessage(botToken: string, chatId: number, post: DBPost, matchedKeywords: string[]): Promise<boolean> {
  try {
    const bot = new Bot(botToken)
    
    // 构建帖子链接
    const postUrl = `https://www.nodeseek.com/post-${post.post_id}-1`
    
    const message = `🎯 ${matchedKeywords.join(', ')}\n\n` +
      `[${post.title}](${postUrl})`
    
    await bot.api.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    } as any)
    
    return true
  } catch (error) {
    console.error('发送Telegram消息失败:', error)
    return false
  }
}

// 主监控函数
async function monitorRSS(env: Env): Promise<{ success: boolean; message: string; stats: any }> {
  try {
    console.log('开始RSS监控...')
    
    // 第一步：获取RSS数据并保存到数据库
    const rssPosts = await fetchRSSData()
    if (rssPosts.length === 0) {
      return { success: false, message: '未获取到RSS数据', stats: {} }
    }
    
    // 保存RSS数据到数据库
    const savedCount = await savePostsToDatabase(env.DB, rssPosts)
    console.log(`保存了 ${savedCount} 个新帖子到数据库`)
    
    // 第二步：从数据库获取待推送的帖子
    const posts = await getUnpushedPosts(env.DB)
    if (posts.length === 0) {
      return { 
        success: true, 
        message: '没有待推送的帖子', 
        stats: { 
          rssPostsCount: rssPosts.length,
          savedNewPosts: savedCount,
          postsToCheck: 0
        } 
      }
    }
    
    // 获取所有活跃用户
    const users = await getActiveUsers(env.DB)
    if (users.length === 0) {
      return { 
        success: true, 
        message: '没有活跃用户', 
        stats: { 
          rssPostsCount: rssPosts.length,
          savedNewPosts: savedCount,
          postsToCheck: posts.length 
        } 
      }
    }
    
    let totalNotifications = 0
    let successfulNotifications = 0
    let failedNotifications = 0
    const pushedPostIds = new Set<number>()
    
    // 遍历每个用户
    for (const user of users) {
      try {
        // 获取用户的关键词订阅
        const keywordSubs = await getUserKeywords(env.DB, user.id)
        
        if (keywordSubs.length === 0) {
          continue
        }
        
        // 遍历每个帖子
        for (const post of posts) {
          // 检查是否已经发送过通知
          if (await isAlreadySent(env.DB, user.chat_id, post.post_id)) {
            continue
          }
          
          // 检查关键词匹配
          for (const keywords of keywordSubs) {
            if (matchKeywords(post, keywords)) {
              totalNotifications++
              
              // 发送Telegram消息
              const matchedKeywordsList = [
                keywords.keyword1,
                keywords.keyword2,
                keywords.keyword3
              ].filter(Boolean) as string[]
              
              const sent = await sendTelegramMessage(env.BOT_TOKEN, user.chat_id, post, matchedKeywordsList)
              
              if (sent) {
                successfulNotifications++
                await logPush(env.DB, user.id, user.chat_id, post.post_id, keywords.id, 1)
                pushedPostIds.add(post.post_id)
              } else {
                failedNotifications++
                await logPush(env.DB, user.id, user.chat_id, post.post_id, keywords.id, 0, '发送失败')
              }
              
              // 每个帖子对每个用户只发送一次，即使匹配多个关键词
              break
            }
          }
        }
      } catch (error) {
        console.error(`处理用户 ${user.chat_id} 时出错:`, error)
      }
    }
    
    // 标记已推送的帖子
    for (const postId of pushedPostIds) {
      await markPostAsPushed(env.DB, postId)
    }
    
    const stats = {
      rssPostsCount: rssPosts.length,
      savedNewPosts: savedCount,
      postsToCheck: posts.length,
      users: users.length,
      totalNotifications,
      successfulNotifications,
      failedNotifications,
      pushedPosts: pushedPostIds.size
    }
    
    return {
      success: true,
      message: `监控完成，保存了 ${savedCount} 个新帖子，发送了 ${successfulNotifications} 条通知`,
      stats
    }
    
  } catch (error) {
    console.error('RSS监控失败:', error)
    return {
      success: false,
      message: `监控失败: ${error}`,
      stats: {}
    }
  }
}

// HTTP触发监控
monitor.post('/check', async (c) => {
  const result = await monitorRSS(c.env)
  return c.json(result)
})

// 手动触发监控（GET请求）
monitor.get('/check', async (c) => {
  const result = await monitorRSS(c.env)
  return c.json(result)
})

// 监控状态检查
monitor.get('/status', (c) => {
  return c.json({
    service: 'RSS Monitor Service',
    status: 'running',
    version: '1.0.0',
    endpoints: [
      'POST /monitor/check - 手动触发监控',
      'GET /monitor/check - 手动触发监控（GET方式）',
      'GET /monitor/status - 服务状态'
    ],
    timestamp: new Date().toISOString()
  })
})

// 定时任务处理函数（供Cron触发使用）
export async function handleScheduled(env: Env): Promise<void> {
  console.log('定时任务触发RSS监控...')
  const result = await monitorRSS(env)
  console.log('定时任务完成:', result)
}

export default monitor 