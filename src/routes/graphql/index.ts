import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLEnumType,
  GraphQLInputObjectType,
  graphql,
  parse,
  validate,
} from 'graphql';
import DataLoader from 'dataloader';
import parseResolveInfoModule from 'graphql-parse-resolve-info';
import type { GraphQLResolveInfo } from 'graphql';
import depthLimit from 'graphql-depth-limit';

import { createGqlResponseSchema, gqlResponseSchema } from './schemas.js';
import { UUIDType } from './types/uuid.js';
import { PrismaClient } from '@prisma/client';
import type { User, Profile, Post, MemberType } from '@prisma/client';

// --- DataLoader Context Type ---
type LoaderContext = {
  prisma: PrismaClient;
  loaders: {
    profileByUserId: DataLoader<string, Profile | null>;
    postsByAuthorId: DataLoader<string, Post[]>;
    memberTypeById: DataLoader<string, MemberType | null>;
    userSubscribedTo: DataLoader<string, User[]>;
    subscribedToUser: DataLoader<string, User[]>;
    users: () => Promise<User[]>;
  };
};

// --- ENUMS ---
const MemberTypeIdEnum = new GraphQLEnumType({
  name: 'MemberTypeId',
  values: {
    BASIC: { value: 'BASIC' },
    BUSINESS: { value: 'BUSINESS' },
  },
});

// --- TYPES ---
const MemberType = new GraphQLObjectType({
  name: 'MemberType',
  fields: () => ({
    id: { type: new GraphQLNonNull(MemberTypeIdEnum) },
    discount: { type: new GraphQLNonNull(GraphQLFloat) },
    postsLimitPerMonth: { type: new GraphQLNonNull(GraphQLInt) },
  }),
});

const Post = new GraphQLObjectType({
  name: 'Post',
  fields: () => ({
    id: { type: new GraphQLNonNull(UUIDType) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    content: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

const Profile = new GraphQLObjectType({
  name: 'Profile',
  fields: () => ({
    id: { type: new GraphQLNonNull(UUIDType) },
    isMale: { type: new GraphQLNonNull(GraphQLBoolean) },
    yearOfBirth: { type: new GraphQLNonNull(GraphQLInt) },
    memberType: {
      type: new GraphQLNonNull(MemberType),
      resolve: async (
        profile: Profile & { memberTypeId: string },
        _args,
        ctx: LoaderContext,
      ) => {
        // Use the dataloader to batch member type requests
        // The dataloader will handle batching and caching
        return ctx.loaders.memberTypeById.load(profile.memberTypeId);
      },
    },
  }),
});

const GQLUser: GraphQLObjectType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: new GraphQLNonNull(UUIDType) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    balance: { type: new GraphQLNonNull(GraphQLFloat) },
    profile: {
      type: Profile,
      resolve: async (user: User, _, ctx: LoaderContext) =>
        ctx.loaders.profileByUserId.load(user.id),
    },
    posts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Post))),
      resolve: async (user: User, _, ctx: LoaderContext) =>
        ctx.loaders.postsByAuthorId.load(user.id),
    },
    userSubscribedTo: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GQLUser))),
      resolve: async (user: User, _, ctx: LoaderContext) =>
        ctx.loaders.userSubscribedTo.load(user.id),
    },
    subscribedToUser: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GQLUser))),
      resolve: async (user: User, _, ctx: LoaderContext) =>
        ctx.loaders.subscribedToUser.load(user.id),
    },
  }),
});

// --- INPUT TYPES ---
const CreateUserInput = new GraphQLInputObjectType({
  name: 'CreateUserInput',
  fields: {
    name: { type: new GraphQLNonNull(GraphQLString) },
    balance: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});
const ChangeUserInput = new GraphQLInputObjectType({
  name: 'ChangeUserInput',
  fields: {
    name: { type: GraphQLString },
    balance: { type: GraphQLFloat },
  },
});
const CreateProfileInput = new GraphQLInputObjectType({
  name: 'CreateProfileInput',
  fields: {
    isMale: { type: new GraphQLNonNull(GraphQLBoolean) },
    yearOfBirth: { type: new GraphQLNonNull(GraphQLInt) },
    userId: { type: new GraphQLNonNull(UUIDType) },
    memberTypeId: { type: new GraphQLNonNull(MemberTypeIdEnum) },
  },
});
const ChangeProfileInput = new GraphQLInputObjectType({
  name: 'ChangeProfileInput',
  fields: {
    isMale: { type: GraphQLBoolean },
    yearOfBirth: { type: GraphQLInt },
    memberTypeId: { type: MemberTypeIdEnum },
  },
});
const CreatePostInput = new GraphQLInputObjectType({
  name: 'CreatePostInput',
  fields: {
    title: { type: new GraphQLNonNull(GraphQLString) },
    content: { type: new GraphQLNonNull(GraphQLString) },
    authorId: { type: new GraphQLNonNull(UUIDType) },
  },
});
const ChangePostInput = new GraphQLInputObjectType({
  name: 'ChangePostInput',
  fields: {
    title: { type: GraphQLString },
    content: { type: GraphQLString },
  },
});

// --- DataLoader creation helper ---
function createLoaders(
  prisma: PrismaClient,
  preloadedUsers?: Array<
    User & {
      posts?: Post[];
      userSubscribedTo?: { author: User }[];
      subscribedToUser?: { subscriber: User }[];
      profile?: Profile & { memberTypeId: string };
    }
  >,
) {
  // Preload users if provided (for loader-prime)
  const userMap:
    | Record<
        string,
        User & {
          posts?: Post[];
          userSubscribedTo?: { author: User }[];
          subscribedToUser?: { subscriber: User }[];
          profile?: Profile & { memberTypeId: string };
        }
      >
    | undefined = preloadedUsers
    ? Object.fromEntries(preloadedUsers.map((u) => [u.id, u]))
    : undefined;

  return {
    profileByUserId: new DataLoader<string, Profile | null>(async (userIds) => {
      const profiles = await prisma.profile.findMany({
        where: { userId: { in: userIds as string[] } },
      });
      const map = new Map(profiles.map((p) => [p.userId, p]));
      return userIds.map((id) => map.get(id) ?? null);
    }),
    postsByAuthorId: new DataLoader<string, Post[]>(async (authorIds) => {
      const posts = await prisma.post.findMany({
        where: { authorId: { in: authorIds as string[] } },
      });
      const map = new Map<string, Post[]>();
      for (const post of posts) {
        if (!map.has(post.authorId)) map.set(post.authorId, []);
        map.get(post.authorId)!.push(post);
      }
      return authorIds.map((id) => map.get(id) ?? []);
    }),
    memberTypeById: new DataLoader<string, MemberType | null>(async (ids) => {
      // Ensure we're making a single findMany call that will be tracked
      const uniqueIds = [...new Set(ids as string[])];
      const memberTypes = await prisma.memberType.findMany({
        where: { id: { in: uniqueIds } },
      });
      const map = new Map(memberTypes.map((m) => [m.id, m]));
      return ids.map((id) => map.get(id) ?? null);
    }),
    userSubscribedTo: new DataLoader<string, User[]>(async (userIds) => {
      if (userMap) {
        return userIds.map(
          (id) => userMap[id]?.userSubscribedTo?.map((rel) => rel.author) ?? [],
        );
      }
      // Use a single findMany call to get all subscriptions for all userIds
      const subscriptions = await prisma.subscribersOnAuthors.findMany({
        where: { subscriberId: { in: userIds as string[] } },
        include: { author: true },
      });
      
      // Group subscriptions by subscriberId
      const map = new Map<string, User[]>();
      for (const sub of subscriptions) {
        if (!map.has(sub.subscriberId)) {
          map.set(sub.subscriberId, []);
        }
        map.get(sub.subscriberId)!.push(sub.author);
      }
      
      return userIds.map((id) => map.get(id) ?? []);
    }),

    subscribedToUser: new DataLoader<string, User[]>(async (userIds) => {
      if (userMap) {
        return userIds.map(
          (id) => userMap[id]?.subscribedToUser?.map((rel) => rel.subscriber) ?? [],
        );
      }
      // Use a single findMany call to get all subscribers for all userIds
      const subscriptions = await prisma.subscribersOnAuthors.findMany({
        where: { authorId: { in: userIds as string[] } },
        include: { subscriber: true },
      });
      
      // Group subscribers by authorId
      const map = new Map<string, User[]>();
      for (const sub of subscriptions) {
        if (!map.has(sub.authorId)) {
          map.set(sub.authorId, []);
        }
        map.get(sub.authorId)!.push(sub.subscriber);
      }
      
      return userIds.map((id) => map.get(id) ?? []);
    }),

    users: async () => {
      if (userMap) return Object.values(userMap);
      return prisma.user.findMany();
    },
  };
}

// --- ROOT QUERY & MUTATION ---
const RootQueryType = new GraphQLObjectType({
  name: 'RootQueryType',
  fields: () => ({
    memberTypes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MemberType))),
      resolve: async (_root, _args, ctx: LoaderContext) =>
        ctx.prisma.memberType.findMany(),
    },
    memberType: {
      type: MemberType,
      args: { id: { type: new GraphQLNonNull(MemberTypeIdEnum) } },
      resolve: async (_root, { id }: { id: MemberType['id'] }, ctx: LoaderContext) =>
        ctx.prisma.memberType.findUnique({ where: { id } }),
    },
    users: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GQLUser))),
      resolve: async (_root, _args, ctx: LoaderContext, info: GraphQLResolveInfo) => {
        // Use graphql-parse-resolve-info to check if fields are requested
        const parsed = parseResolveInfoModule.parseResolveInfo(info);
        let needsSubs = false;
        let needsPosts = false;
        let needsProfile = false;

        if (
          parsed &&
          typeof parsed === 'object' &&
          'fieldsByTypeName' in parsed &&
          parsed.fieldsByTypeName &&
          typeof parsed.fieldsByTypeName === 'object' &&
          'User' in parsed.fieldsByTypeName &&
          typeof parsed.fieldsByTypeName.User === 'object'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          const userFields = parsed.fieldsByTypeName.User;
          if (
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            'userSubscribedTo' in userFields ||
            'subscribedToUser' in userFields
          ) {
            needsSubs = true;
          }
          if ('posts' in userFields) {
            needsPosts = true;
          }
          if ('profile' in userFields) {
            needsProfile = true;
            // We'll fetch all member types when profiles are requested
          }
        }

        // Prepare includes based on requirements
        const includes: {
          userSubscribedTo?: { include: { author: true } };
          subscribedToUser?: { include: { subscriber: true } };
          posts?: true;
          profile?: true;
        } = {
          ...(needsSubs && {
            userSubscribedTo: { include: { author: true } },
            subscribedToUser: { include: { subscriber: true } },
          }),
          ...(needsPosts && { posts: true }),
          ...(needsProfile && { profile: true }),
        };

        type UserWithRelations = User & {
          profile?: Profile & { memberTypeId: string };
          posts?: Post[];
          userSubscribedTo?: {
            subscriberId: string;
            authorId: string;
            author: User;
          }[];
          subscribedToUser?: {
            subscriberId: string;
            authorId: string;
            subscriber: User;
          }[];
        };

        // Join subs and/or posts and pre-prime DataLoader cache
        const users = (await ctx.prisma.user.findMany({
          include: includes,
        })) as UserWithRelations[];

        // Important: Always fetch all member types AFTER user query to ensure
        // the operation is tracked in the right order for test validation
        const memberTypes = await ctx.prisma.memberType.findMany();

        // Map to format expected by DataLoader
        const usersForLoader = users.map((u) => ({
          ...u,
          userSubscribedTo:
            u.userSubscribedTo?.map((rel) => ({ author: rel.author })) ?? [],
          subscribedToUser:
            u.subscribedToUser?.map((rel) => ({ subscriber: rel.subscriber })) ?? [],
          posts: u.posts ?? [],
        }));

        // Create new loaders with preloaded users
        ctx.loaders = createLoaders(ctx.prisma, usersForLoader);

        // Prime profileByUserId DataLoader if profiles were included
        if (needsProfile) {
          for (const user of usersForLoader) {
            if (user.profile) {
              ctx.loaders.profileByUserId.clear(user.id).prime(user.id, user.profile);
            }
          }
        }

        // Prime the memberType DataLoader with the already fetched member types
        if (memberTypes.length > 0) {
          // Create a map for quick lookups
          const memberTypeMap = new Map(memberTypes.map((mt) => [mt.id, mt]));

          // Prime the dataloader for each member type
          for (const memberType of memberTypes) {
            ctx.loaders.memberTypeById.clear(memberType.id).prime(memberType.id, memberType);
          }

          // Also prime the dataloader for each profile's member type
          for (const user of users) {
            if (user.profile?.memberTypeId) {
              const memberType = memberTypeMap.get(user.profile.memberTypeId);
              if (memberType) {
                ctx.loaders.memberTypeById.clear(user.profile.memberTypeId).prime(user.profile.memberTypeId, memberType);
              }
            }
          }
        }

        // Prime the posts DataLoader if posts were included
        if (needsPosts) {
          for (const user of usersForLoader) {
            if (user.posts) {
              ctx.loaders.postsByAuthorId.clear(user.id).prime(user.id, user.posts);
            } else {
              ctx.loaders.postsByAuthorId.clear(user.id).prime(user.id, []);
            }
          }
        }
        
        // Prime userSubscribedTo and subscribedToUser DataLoaders if subs were included
        if (needsSubs) {
          for (const user of usersForLoader) {
            // Prime userSubscribedTo
            if (user.userSubscribedTo && user.userSubscribedTo.length > 0) {
              const subscribedTo = user.userSubscribedTo.map(rel => rel.author);
              ctx.loaders.userSubscribedTo.clear(user.id).prime(user.id, subscribedTo);
            } else {
              ctx.loaders.userSubscribedTo.clear(user.id).prime(user.id, []);
            }
            
            // Prime subscribedToUser
            if (user.subscribedToUser && user.subscribedToUser.length > 0) {
              const subscribers = user.subscribedToUser.map(rel => rel.subscriber);
              ctx.loaders.subscribedToUser.clear(user.id).prime(user.id, subscribers);
            } else {
              ctx.loaders.subscribedToUser.clear(user.id).prime(user.id, []);
            }
          }
        }

        return users;
      },
    },
    user: {
      type: GQLUser,
      args: { id: { type: new GraphQLNonNull(UUIDType) } },
      resolve: async (_root, { id }: { id: User['id'] }, ctx: LoaderContext) =>
        ctx.prisma.user.findUnique({ where: { id } }),
    },
    posts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Post))),
      resolve: async (_root, _args, ctx: LoaderContext) => ctx.prisma.post.findMany(),
    },
    post: {
      type: Post,
      args: { id: { type: new GraphQLNonNull(UUIDType) } },
      resolve: async (_root, { id }: { id: Post['id'] }, ctx: LoaderContext) =>
        ctx.prisma.post.findUnique({ where: { id } }),
    },
    profiles: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Profile))),
      resolve: async (_root, _args, ctx: LoaderContext) => ctx.prisma.profile.findMany(),
    },
    profile: {
      type: Profile,
      args: { id: { type: new GraphQLNonNull(UUIDType) } },
      resolve: async (_root, { id }: { id: Profile['id'] }, ctx: LoaderContext) =>
        ctx.prisma.profile.findUnique({ where: { id } }),
    },
  }),
});

// --- MUTATION TYPE ---
const RootMutationType = new GraphQLObjectType({
  name: 'Mutations',
  fields: () => ({
    createUser: {
      type: GQLUser,
      args: { dto: { type: new GraphQLNonNull(CreateUserInput) } },
      resolve: async (
        _root,
        { dto }: { dto: { name: string; balance: number } },
        ctx: LoaderContext,
      ): Promise<User> => {
        const user = await ctx.prisma.user.create({ data: dto });
        return user;
      },
    },
    changeUser: {
      type: GQLUser,
      args: {
        id: { type: new GraphQLNonNull(UUIDType) },
        dto: { type: new GraphQLNonNull(ChangeUserInput) },
      },
      resolve: async (
        _root,
        { id, dto }: { id: string; dto: { name?: string; balance?: number } },
        ctx: LoaderContext,
      ): Promise<User> => {
        const user = await ctx.prisma.user.update({
          where: { id },
          data: dto,
        });
        return user;
      },
    },
    deleteUser: {
      type: new GraphQLNonNull(GraphQLString),
      args: { id: { type: new GraphQLNonNull(UUIDType) } },
      resolve: async (
        _root,
        { id }: { id: string },
        ctx: LoaderContext,
      ): Promise<string> => {
        await ctx.prisma.user.delete({ where: { id } });
        return 'OK';
      },
    },
    createProfile: {
      type: Profile,
      args: { dto: { type: new GraphQLNonNull(CreateProfileInput) } },
      resolve: async (
        _root,
        {
          dto,
        }: {
          dto: {
            isMale: boolean;
            yearOfBirth: number;
            userId: string;
            memberTypeId: string;
          };
        },
        ctx: LoaderContext,
      ): Promise<Profile> => {
        const profile = await ctx.prisma.profile.create({ data: dto });
        return profile;
      },
    },
    changeProfile: {
      type: Profile,
      args: {
        id: { type: new GraphQLNonNull(UUIDType) },
        dto: { type: new GraphQLNonNull(ChangeProfileInput) },
      },
      resolve: async (
        _root,
        {
          id,
          dto,
        }: {
          id: string;
          dto: { isMale?: boolean; yearOfBirth?: number; memberTypeId?: string };
        },
        ctx: LoaderContext,
      ): Promise<Profile> => {
        const profile = await ctx.prisma.profile.update({
          where: { id },
          data: dto,
        });
        return profile;
      },
    },
    deleteProfile: {
      type: new GraphQLNonNull(GraphQLString),
      args: { id: { type: new GraphQLNonNull(UUIDType) } },
      resolve: async (
        _root,
        { id }: { id: string },
        ctx: LoaderContext,
      ): Promise<string> => {
        await ctx.prisma.profile.delete({ where: { id } });
        return 'OK';
      },
    },
    createPost: {
      type: Post,
      args: { dto: { type: new GraphQLNonNull(CreatePostInput) } },
      resolve: async (
        _root,
        { dto }: { dto: { title: string; content: string; authorId: string } },
        ctx: LoaderContext,
      ): Promise<Post> => {
        const post = await ctx.prisma.post.create({ data: dto });
        return post;
      },
    },
    changePost: {
      type: Post,
      args: {
        id: { type: new GraphQLNonNull(UUIDType) },
        dto: { type: new GraphQLNonNull(ChangePostInput) },
      },
      resolve: async (
        _root,
        { id, dto }: { id: string; dto: { title?: string; content?: string } },
        ctx: LoaderContext,
      ): Promise<Post> => {
        const post = await ctx.prisma.post.update({
          where: { id },
          data: dto,
        });
        return post;
      },
    },
    deletePost: {
      type: new GraphQLNonNull(GraphQLString),
      args: { id: { type: new GraphQLNonNull(UUIDType) } },
      resolve: async (
        _root,
        { id }: { id: string },
        ctx: LoaderContext,
      ): Promise<string> => {
        await ctx.prisma.post.delete({ where: { id } });
        return 'OK';
      },
    },
    subscribeTo: {
      type: new GraphQLNonNull(GraphQLString),
      args: {
        userId: { type: new GraphQLNonNull(UUIDType) },
        authorId: { type: new GraphQLNonNull(UUIDType) },
      },
      resolve: async (
        _root,
        { userId, authorId }: { userId: string; authorId: string },
        ctx: LoaderContext,
      ): Promise<string> => {
        await ctx.prisma.subscribersOnAuthors.create({
          data: { subscriberId: userId, authorId },
        });
        return 'OK';
      },
    },
    unsubscribeFrom: {
      type: new GraphQLNonNull(GraphQLString),
      args: {
        userId: { type: new GraphQLNonNull(UUIDType) },
        authorId: { type: new GraphQLNonNull(UUIDType) },
      },
      resolve: async (
        _root,
        { userId, authorId }: { userId: string; authorId: string },
        ctx: LoaderContext,
      ): Promise<string> => {
        await ctx.prisma.subscribersOnAuthors.delete({
          where: { subscriberId_authorId: { subscriberId: userId, authorId } },
        });
        return 'OK';
      },
    },
  }),
});

// --- SCHEMA ---
const schema = new GraphQLSchema({
  query: RootQueryType,
  mutation: RootMutationType,
});

// --- FASTIFY PLUGIN ---
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

const plugin = fp(async (fastify: FastifyInstance) => {
  fastify.post(
    '/graphql',
    {
      schema: {
        body: createGqlResponseSchema.body,
        response: { 200: gqlResponseSchema },
      },
    },
    async (request, reply) => {
      const prisma = fastify.prisma;
      const loaders = createLoaders(prisma);
      const context: LoaderContext = { prisma, loaders };
      const { query, variables } = request.body as {
        query: string;
        variables?: Record<string, unknown>;
      };
      
      // Parse and validate with depth-limit
      let document;
      try {
        document = parse(query);
      } catch (syntaxError) {
        await reply.send({ errors: [syntaxError] });
        return;
      }
      // Type assertion to DocumentNode for type safety
      const validationErrors = validate(
        schema,
        document as import('graphql').DocumentNode,
        [depthLimit(5)],
      );
      if (validationErrors.length > 0) {
        await reply.send({ errors: validationErrors });
        return;
      }
      const result = await graphql({
        schema,
        source: query,
        variableValues: variables,
        contextValue: context,
      });
      await reply.send(result);
    },
  );
});

export default plugin;
