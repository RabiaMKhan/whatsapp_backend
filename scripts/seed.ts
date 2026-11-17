/**
 * Fills the local database with demo users, chats and messages for UI work.
 * WARNING: deletes all users, sessions, conversations and messages first.
 *
 *   npm run seed
 */
import type { Types } from 'mongoose';
import { env } from '../src/config/env';
import { connectDatabase, disconnectDatabase } from '../src/db/connect';
import { pickAvatarColor } from '@chat/shared';
import { hashPassword } from '../src/lib/password';
import { Conversation } from '../src/models/conversation.model';
import { AuthCode } from '../src/models/auth-code.model';
import { Message } from '../src/models/message.model';
import { Session } from '../src/models/session.model';
import { User } from '../src/models/user.model';

if (env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV is production.');
  process.exit(1);
}

// Local test login only. Every demo user gets this password.
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';

const PEOPLE = {
  demo: { name: 'Demo User', email: 'demo@example.com' },
  ayesha: { name: 'Ayesha Malik', email: 'ayesha@example.com' },
  daniel: { name: 'Daniel Brooks', email: 'daniel@example.com' },
  sara: { name: 'Sara Ahmed', email: 'sara@example.com' },
  omar: { name: 'Omar Farooq', email: 'omar@example.com' },
  emily: { name: 'Emily Carter', email: 'emily@example.com' },
} as const;

type Person = keyof typeof PEOPLE;
/** [sender, minutes ago, text] */
type Line = [Person, number, string];

interface ChatSeed {
  type: 'direct' | 'group';
  name?: string;
  members: Person[];
  lines: Line[];
  /** How many of the last messages the demo user has not read yet. */
  unreadForDemo?: number;
}

const CHATS: ChatSeed[] = [
  {
    type: 'direct',
    members: ['demo', 'ayesha'],
    unreadForDemo: 2,
    lines: [
      ['ayesha', 190, 'Morning! Did you get a chance to look at the new onboarding screens?'],
      ['demo', 185, 'Yes, just went through them. The flow feels much cleaner now.'],
      ['demo', 184, 'One thing: the step indicator is hard to see in dark mode.'],
      ['ayesha', 170, "Good catch. I'll bump the contrast on the inactive steps."],
      ['ayesha', 12, 'Updated the Figma file with the contrast fix 👀'],
      ['ayesha', 11, 'Can you review before the 3pm sync?'],
    ],
  },
  {
    type: 'group',
    name: 'Product Team',
    members: ['demo', 'ayesha', 'daniel', 'sara', 'omar'],
    unreadForDemo: 3,
    lines: [
      ['sara', 300, 'Quick agenda for this week: release 2.4, the billing bug, and Q1 planning.'],
      ['daniel', 295, 'Billing fix is merged. It goes out with 2.4.'],
      ['omar', 290, 'QA pass on staging is done, no blockers from my side.'],
      ['demo', 280, 'Great. Release notes draft is in the shared folder, please add anything I missed.'],
      ['sara', 45, 'Release is scheduled for Thursday 10am UK time.'],
      ['omar', 40, "I'll keep an eye on error rates for the first hour after deploy."],
      ['daniel', 6, 'Heads up: the migration takes ~5 min, the app stays up the whole time.'],
    ],
  },
  {
    type: 'direct',
    members: ['demo', 'daniel'],
    lines: [
      ['demo', 1500, 'Is the socket server ready for load testing?'],
      ['daniel', 1490, 'Almost. Adding the Redis adapter so we can run two instances.'],
      ['demo', 1485, "Nice, let me know when it's on staging."],
      ['daniel', 1440, "It's on staging now. 2k concurrent connections, no issues."],
      ['demo', 1435, 'Perfect, thanks!'],
    ],
  },
  {
    type: 'direct',
    members: ['demo', 'emily'],
    lines: [
      ['emily', 4400, 'Hi! I just joined the support team. Nice to meet you 👋'],
      ['demo', 4390, 'Welcome Emily! Ping me any time if you need access to something.'],
    ],
  },
  {
    type: 'direct',
    members: ['demo', 'sara'],
    lines: [
      ['sara', 10_100, 'Can we move our 1:1 to Friday?'],
      ['demo', 10_080, 'Sure, Friday works.'],
    ],
  },
];

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function main() {
  await connectDatabase();
  await Promise.all([User.init(), Session.init(), AuthCode.init(), Conversation.init(), Message.init()]);
  await Promise.all([
    User.deleteMany({}),
    Session.deleteMany({}),
    AuthCode.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
  ]);

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const ids = {} as Record<Person, Types.ObjectId>;
  for (const [key, person] of Object.entries(PEOPLE) as [Person, (typeof PEOPLE)[Person]][]) {
    const user = await User.create({
      ...person,
      passwordHash,
      avatarColor: pickAvatarColor(person.email),
      emailVerifiedAt: minutesAgo(20_000),
      lastSeenAt: minutesAgo(30 + Math.floor(Math.random() * 600)),
    });
    ids[key] = user._id;
  }

  let messageCount = 0;
  for (const chat of CHATS) {
    const lines = [...chat.lines].sort((a, b) => b[1] - a[1]); // oldest first
    const first = lines[0]!;
    const last = lines[lines.length - 1]!;
    const demoReadLine = lines[lines.length - 1 - (chat.unreadForDemo ?? 0)];

    const conversation = new Conversation({
      type: chat.type,
      name: chat.name ?? null,
      directKey: chat.type === 'direct' ? chat.members.map((m) => ids[m].toString()).sort().join(':') : null,
      createdBy: ids[chat.members[0]!],
      members: chat.members.map((member, i) => ({
        user: ids[member],
        role: chat.type === 'group' && i === 0 ? 'owner' : 'member',
        joinedAt: minutesAgo(first[1] + 10),
        lastReadAt: member === 'demo' ? (demoReadLine ? minutesAgo(demoReadLine[1]) : null) : minutesAgo(last[1]),
      })),
      createdAt: minutesAgo(first[1] + 10),
      updatedAt: minutesAgo(last[1]),
      lastMessageAt: minutesAgo(last[1]),
    });

    // Insert in time order so message _ids sort the same way as createdAt.
    let lastDoc = null;
    for (const [sender, ago, body] of lines) {
      const createdAt = minutesAgo(ago);
      lastDoc = new Message({ conversation: conversation._id, sender: ids[sender], body, createdAt, updatedAt: createdAt });
      await lastDoc.save({ timestamps: false });
      messageCount++;
    }

    if (lastDoc) {
      conversation.lastMessage = {
        messageId: lastDoc._id,
        body: lastDoc.body,
        sender: lastDoc.sender,
        createdAt: lastDoc.createdAt,
      };
    }
    await conversation.save({ timestamps: false });
  }

  console.log(`Seeded ${Object.keys(PEOPLE).length} users, ${CHATS.length} conversations, ${messageCount} messages.`);
  console.log(`Sign in as ${PEOPLE.demo.email} (or any other demo user) with the SEED_PASSWORD in scripts/seed.ts.`);
  await disconnectDatabase();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
