require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors'); 
const InventoryService = require('./services/InventoryService');
const AntiAbuseService = require('./services/AntiAbuseService');

// 1. 設定
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 初始化 Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Initialize Services
const inventoryService = new InventoryService(supabase);
const antiAbuseService = new AntiAbuseService(supabase);

// 初始化 Express
const app = express();

// --- 中介軟體 (Middleware) ---
app.use(cors());

// ⚠️ 重要修正：LINE Webhook 必須放在 express.json() 之前！
// 因為它需要讀取原始的 binary stream 來驗證簽章
app.post('/callback', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// ⚠️ 這裡才開始啟用 JSON 解析 (給後面的 API 使用)
app.use(express.json());
app.use(express.static('public')); 

// ==========================================
// API 區域
// ==========================================

// API 1: 查詢時段
app.get('/api/slots', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: '缺少 date 參數' });

  try {
    // Inventory Mode: Use service to get slots
    const slotsData = await inventoryService.getSlots(date);
    res.json({ date, slots: slotsData });
  } catch (err) {
    console.error('查詢失敗:', err);
    res.status(500).json({ error: '資料庫查詢錯誤' });
  }
});

// API 2: 預約 (防黃牛版 + Inventory Mode)
app.post('/api/bookings', async (req, res) => {
  const { userId, date, time } = req.body; 

  if (!userId || !date || !time) {
    return res.status(400).json({ error: '資料不完整' });
  }

  try {
    const { data: user } = await supabase.from('users').select('id, blocked, throttled, group_id').eq('line_user_id', userId).single();
    if (!user) return res.status(404).json({ error: '找不到此用戶' });

    // --- Anti-Abuse Checks ---
    // 1. Check Status (Blacklist / Throttling)
    await antiAbuseService.checkUserStatus(user.id);

    // 2. Check Group Quota
    await antiAbuseService.checkGroupQuota(user.id, date);

    // --- Inventory & Booking Logic ---

    // 3. Rule B: Daily limit (Still applies?) - Spec doesn't explicitly remove it, implies user cancellation needed.
    // Let's keep it as a basic sanity check.
    const { data: myBookings } = await supabase
      .from('appointments')
      .select('id')
      .eq('user_id', user.id)
      .eq('booking_date', date)
      .in('status', ['pending', 'confirmed']);

    if (myBookings && myBookings.length > 0) {
      return res.status(400).json({ error: '您當天已有預約，請勿重複佔位' });
    }

    // 4. Rule A: Attempt to lock slot (Inventory Mode)
    // format time to ensure HH:MM:00 match if needed, though input '08:00' matches TIME type usually
    const slotId = await inventoryService.attemptBooking(user.id, date, time);

    // 5. Create Appointment
    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert([{ 
          user_id: user.id,
          booking_date: date,
          start_time: time,
          end_time: `${parseInt(time.split(':')[0]) + 1}:00`,
          status: 'pending' 
      }])
      .select()
      .single();

    if (error) {
        // Rollback slot lock?
        // Since we locked it in DB, we should probably unlock it if appointment creation fails.
        // For now, let's assume if this fails, we have a phantom lock (requires cleanup job or transaction).
        // Supabase-js doesn't support multi-table transactions easily without RPC.
        throw error;
    }

    // 6. Link Appointment to Slot
    await inventoryService.confirmSlotBooking(slotId, appointment.id);

    res.json({ success: true, message: '預約申請已送出' });

  } catch (err) {
    console.error('預約失敗:', err.message);
    if (err.message.includes('User is blocked')) return res.status(403).json({ error: err.message });
    if (err.message.includes('Quota exceeded')) return res.status(403).json({ error: err.message });
    if (err.message.includes('Slot was just taken') || err.message.includes('Slot not found')) return res.status(409).json({ error: err.message });

    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// --- 事件處理 ---
const client = new line.Client(lineConfig);
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);

  const userId = event.source.userId;
  try {
    const { data: user } = await supabase.from('users').select('id').eq('line_user_id', userId).single();
    if (!user) {
      // Updated: Register with defaults
      await supabase.from('users').insert([{
          line_user_id: userId,
          blocked: false,
          throttled: false
      }]);
      console.log(`新用戶 ${userId} 自動註冊成功`);
    }
  } catch (e) { console.error(e); }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `收到：${event.message.text}`
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
module.exports = app; // Export for testing if needed
