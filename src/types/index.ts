export type Role = 'community_manager' | 'worker' | 'client';
export type PostStatus = 'Pendiente' | 'En proceso' | 'Completado' | 'Subido';
export type PostFormat = 'Post' | 'Carrusel' | 'Reel' | 'Historia';
export interface Organization {
    id: string;
    name: string;
}
export interface Company {
    id: string;
    organizationId: string;
    name: string;
    color: string;
}
export interface User {
    id: string;
    name: string;
    role: Role;
    example: boolean;
    email?: string;
}
export interface Membership {
    id: string;
    userId: string;
    companyId: string;
}
export interface Attachment {
    id: string;
    name: string;
    size: number;
    mimeType: string;
}
export interface Comment {
    id: string;
    postId: string;
    authorId: string;
    body: string;
    createdAt: string;
}
export interface Post {
    id: string;
    companyId: string;
    title: string;
    description: string;
    scheduledAt: string;
    format: PostFormat;
    status: PostStatus;
    responsibleId: string;
    visible_para_cliente: boolean;
    attachments: Attachment[];
    instagramUrl?: string;
    confirmadoPor?: string;
    confirmadoEn?: string;
}
export interface State {
    version: 3;
    revision: number;
    activeUserId: string;
    invitations: Invitation[];
    comments: Comment[];
    organization: Organization;
    companies: Company[];
    users: User[];
    memberships: Membership[];
    posts: Post[];
    role: Role;
    authenticated: boolean;
    activeCompanyId: string;
}

export interface Invitation {
    id: string;
    code: string;
    organizationId: string;
    email: string;
    role: 'worker' | 'client';
    companyIds: string[];
    validityDays: 1 | 7 | 30;
    createdAt: string;
    expiresAt: string;
    usedAt?: string;
    usedBy?: string;
    revokedAt?: string;
}
