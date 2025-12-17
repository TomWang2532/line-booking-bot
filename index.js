require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { DateTime } = require('luxon');

// Configuration
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Initialize Express
const app = express();

// Middleware
app.use(cors());

// Helpers
const getTaipeiTime = () => DateTime.now().setZone('Asia/Taipei');

// LINE Webhook
app.post('/callback', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// JSON Parser for API
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// API Endpoints
// ==========================================

// GET /api/slots: Check Availability
app.get('/api/slots', async (req, res) => {
  const { date } = req.query; // Expect YYYY-MM-DD
  if (!date) return res.status(400).json({ error: '缺少日期參數' });

  try {
    // Query daily_slots (check is_open=true, status='AVAILABLE')
    const { data: slots, error } = await supabase
      .from('daily_slots')
      .select('time, status')
      .eq('date', date)
      .eq('is_open', true)
      .eq('status', 'AVAILABLE');

    if (error) throw error;

    // Return format compatible with frontend expecting slots list
    // Assuming daily_slots has 'time' as 'HH:mm' or similar
    const availableSlots = slots.map(s => s.time);

    // If frontend expects a full list with availability status, we might need to adjust.
    // Based on previous code, it generated 8-21.
    // The new requirement says "Query daily_slots". So we return what's in DB.
    // We'll wrap it to be nice.
    res.json({ date, available_slots: availableSlots });

  } catch (err) {
    console.error('Error fetching slots:', err);
    res.status(500).json({ error: '無法取得時段資訊' });
  }
});

// POST /api/register: Update User Profile
app.post('/api/register', async (req, res) => {
  const { userId, real_name, phone, referrer } = req.body;

  if (!userId || !real_name || !phone) {
    return res.status(400).json({ error: '請填寫完整資料' });
  }

  try {
    // Upsert user based on line_user_id
    // First check if user exists to get ID, or just upsert by line_user_id if unique
    // Assuming line_user_id is unique key
    const { data, error } = await supabase
      .from('users')
      .upsert({
        line_user_id: userId,
        real_name,
        phone,
        referrer,
        // Ensure default values if new
        is_blocked: false,
        is_throttled: false
      }, { onConflict: 'line_user_id' })
      .select();

    if (error) throw error;

    res.json({ message: '註冊成功', user: data[0] });

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: '註冊失敗，請稍後再試' });
  }
});

// POST /api/bookings: Create Booking
app.post('/api/bookings', async (req, res) => {
  const { userId, date, time } = req.body;

  if (!userId || !date || !time) {
    return res.status(400).json({ error: '資料不完整' });
  }

  try {
    // 1. Get System Settings
    // Assuming a single row or we take the first one
    const { data: settings, error: settingsError } = await supabase
      .from('system_settings')
      .select('is_booking_open, next_opening_info, group_max_quota')
      .limit(1)
      .single();

    // If settings table is empty or error, handle gracefully or assume defaults?
    // Requirement implies strict checks.
    if (settingsError && settingsError.code !== 'PGRST116') { // PGRST116 is no rows
       console.error('Settings error:', settingsError);
       return res.status(500).json({ error: '系統錯誤' });
    }

    const isBookingOpen = settings ? settings.is_booking_open : true; // Default open? Or closed?
    const nextOpeningInfo = settings ? settings.next_opening_info : '目前不開放預約';
    const groupMaxQuota = settings ? settings.group_max_quota : 999;

    if (!isBookingOpen) {
      return res.status(503).json({ message: nextOpeningInfo });
    }

    // 2. Get User
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('line_user_id', userId)
      .single();

    if (userError && userError.code !== 'PGRST116') throw userError;

    // New User Registration / Missing Profile
    if (!user || !user.real_name) {
      return res.status(403).json({
        error: '請先完善個人資料',
        code: 'REGISTRATION_REQUIRED'
      });
    }

    // Anti-Abuse: Blacklist
    if (user.is_blocked) {
      return res.status(403).json({ error: '您的帳號已被停權' });
    }

    // Anti-Abuse: Throttling
    if (user.is_throttled) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Anti-Abuse: Family Quota
    // Check user_groups & group_max_quota
    // Assuming user has group_id. If not, maybe skip or treat as single?
    // Requirement: "Check user_groups & group_max_quota"
    if (user.group_id) {
       // Calculate start/end of week in Taipei Time
       const now = getTaipeiTime();
       const startOfWeek = now.startOf('week').toISODate(); // Monday
       const endOfWeek = now.endOf('week').toISODate(); // Sunday

       // Find all users in this group
       const { data: groupUsers } = await supabase
         .from('users')
         .select('id')
         .eq('group_id', user.group_id);

       const groupUserIds = groupUsers.map(u => u.id);

       // Count appointments for this group this week
       const { count, error: countError } = await supabase
         .from('appointments')
         .select('id', { count: 'exact', head: true })
         .in('user_id', groupUserIds)
         .gte('booking_date', startOfWeek)
         .lte('booking_date', endOfWeek)
         .in('status', ['pending', 'confirmed']); // Assuming these statuses count

       if (countError) throw countError;

       if (count >= groupMaxQuota) {
         return res.status(400).json({ error: '本週預約額度已滿' });
       }
    }

    // 3. Inventory Mode
    // Check Availability: Query daily_slots
    // We need to find the specific slot ID to update it
    const { data: slot, error: slotError } = await supabase
      .from('daily_slots')
      .select('id, is_open, status')
      .eq('date', date)
      .eq('time', time)
      .single();

    if (slotError && slotError.code !== 'PGRST116') throw slotError;

    if (!slot || !slot.is_open || slot.status !== 'AVAILABLE') {
       return res.status(409).json({ error: '該時段已被預約或未開放' });
    }

    // Create Booking: Insert into appointments -> Update daily_slots to 'LOCKED'
    // Ideally use a transaction or RPC. Here we do sequential operations.
    // Optimistic locking via status check in update would be better but keeping it simple as per instructions.

    // 1. Update daily_slots to LOCKED
    const { data: updatedSlot, error: updateError } = await supabase
      .from('daily_slots')
      .update({ status: 'LOCKED' })
      .eq('id', slot.id)
      .eq('status', 'AVAILABLE') // Optimistic lock
      .select();

    if (updateError) throw updateError;

    if (!updatedSlot || updatedSlot.length === 0) {
      // Slot was taken in between
      return res.status(409).json({ error: '該時段剛被搶走' });
    }

    // 2. Insert into appointments
    const { error: insertError } = await supabase
      .from('appointments')
      .insert([{
        user_id: user.id,
        booking_date: date,
        start_time: time,
        end_time: DateTime.fromFormat(time, 'HH:mm').plus({ hours: 1 }).toFormat('HH:mm'), // Simple 1h duration
        status: 'confirmed' // or pending
      }]);

    if (insertError) {
      // Rollback slot (best effort)
      await supabase.from('daily_slots').update({ status: 'AVAILABLE' }).eq('id', slot.id);
      throw insertError;
    }

    res.json({ message: '預約成功' });

  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: '系統發生錯誤，請稍後再試' });
  }
});

// LINE Event Handler
const client = new line.Client(lineConfig);
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);

  const userId = event.source.userId;
  // We can keep the auto-registration or remove it since we have explicit registration now.
  // The requirement says "If users record is missing ... API should allow updating profile".
  // This usually refers to the Web/LIFF flow.
  // For the bot, maybe we just reply.

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `收到：${event.message.text}`
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
