class AntiAbuseService {
  constructor(supabaseClient) {
    this.supabase = supabaseClient;
  }

  /**
   * Check if user is blocked or throttled.
   * If throttled, introduces a delay.
   * @param {string} userId - The internal DB ID of the user (UUID)
   */
  async checkUserStatus(userId) {
    const { data: user, error } = await this.supabase
      .from('users')
      .select('blocked, throttled')
      .eq('id', userId)
      .single();

    if (error) throw error;
    if (!user) throw new Error('User not found');

    if (user.blocked) {
      throw new Error('User is blocked from making bookings.');
    }

    if (user.throttled) {
      // Targeted Throttling: Delay 3-5 seconds
      const delay = Math.floor(Math.random() * 2000) + 3000; // 3000-5000ms
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  /**
   * Check Group Quota (Family Limit)
   * @param {string} userId
   * @param {string} date - Booking date (YYYY-MM-DD)
   * @param {number} weeklyLimit - Max bookings per week per group (default 2)
   */
  async checkGroupQuota(userId, date, weeklyLimit = 2) {
    // 1. Get user's group_id
    const { data: user, error: userError } = await this.supabase
      .from('users')
      .select('group_id')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    // If no group, skip quota check (or treat as single user group?)
    // Spec says: "bind multiple Users... Group Quota... when 3rd person tries..."
    // Implies users WITHOUT group might not be subject to this, or are their own group.
    // Let's assume only users in a group are checked against GROUP quota.
    if (!user.group_id) return;

    // 2. Calculate start and end of the week for the booking date
    const bookingDate = new Date(date);
    // Adjust to Monday-Sunday week if needed, or just standard week
    // Let's assume standard ISO week (Monday start) or just look at +/- 7 days range?
    // "Weekly limit". Usually means Monday to Sunday.
    const day = bookingDate.getDay();
    const diff = bookingDate.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
    const monday = new Date(bookingDate.setDate(diff));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const startStr = monday.toISOString().split('T')[0];
    const endStr = sunday.toISOString().split('T')[0];

    // 3. Count bookings for this group in this week
    // We need to join users and appointments, OR assume we can query appointments by users in group
    // Supabase filtering:
    // Select appointments where user_id IN (Select id from users where group_id = ?)
    // AND date between start and end
    // AND status IN (pending, confirmed)

    // Using two steps for safety with basic Supabase client:
    // A. Get all user IDs in group
    const { data: groupUsers, error: groupError } = await this.supabase
      .from('users')
      .select('id')
      .eq('group_id', user.group_id);

    if (groupError) throw groupError;
    const groupUserIds = groupUsers.map(u => u.id);

    // B. Count appointments
    const { count, error: countError } = await this.supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .in('user_id', groupUserIds)
      .gte('booking_date', startStr)
      .lte('booking_date', endStr)
      .in('status', ['pending', 'confirmed']);

    if (countError) throw countError;

    if (count >= weeklyLimit) {
      throw new Error(`Group quota exceeded. Max ${weeklyLimit} bookings per week.`);
    }
  }
}

module.exports = AntiAbuseService;
