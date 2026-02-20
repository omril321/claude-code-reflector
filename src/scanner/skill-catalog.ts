/**
 * Loads the skill catalog from ~/.claude/skills/ and CLAUDE.md content
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SKILLS_DIR = join(homedir(), '.claude', 'skills');
const CLAUDE_MD_PATH = join(homedir(), '.claude', 'CLAUDE.md');

export interface SkillInfo {
  name: string;
  description: string;
}

export interface ContextInfo {
  skills: SkillInfo[];
  claudeMdContent: string;
}

/**
 * Load all skills from SKILL.md files and the CLAUDE.md content
 */
export async function loadContext(): Promise<ContextInfo> {
  const skills = await loadSkills();
  const claudeMdContent = await loadClaudeMd();
  return { skills, claudeMdContent };
}

async function loadSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  let dirs: string[];
  try {
    const dirents = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    dirs = dirents.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return skills;
  }

  for (const dir of dirs) {
    const skillPath = join(SKILLS_DIR, dir, 'SKILL.md');
    try {
      const content = await fs.readFile(skillPath, 'utf-8');
      const parsed = parseFrontmatter(content);
      if (parsed.name && parsed.description) {
        skills.push({ name: parsed.name, description: parsed.description });
      }
    } catch {
      continue;
    }
  }

  return skills;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter = match[1];
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();

  return { name, description };
}

async function loadClaudeMd(): Promise<string> {
  try {
    return await fs.readFile(CLAUDE_MD_PATH, 'utf-8');
  } catch {
    return '';
  }
}
