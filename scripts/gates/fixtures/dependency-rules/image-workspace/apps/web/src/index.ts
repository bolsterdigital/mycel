// import { db } from '@fx/db'; a comment is not an import
export { core } from '@fx/core';

export const text = "import('@fx/db')";
export const later = () => import('@fx/core');
