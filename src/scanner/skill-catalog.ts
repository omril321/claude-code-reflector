/**
 * Loads the skill catalog from ~/.claude/skills/ and plugin skills, plus CLAUDE.md content
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SKILLS_DIR = join(homedir(), '.claude', 'skills');
const PLUGINS_CACHE_DIR = join(homedir(), '.claude', 'plugins', 'cache');
const CLAUDE_MD_PATH = join(homedir(), '.claude', 'CLAUDE.md');

export interface SkillInfo {
  name: string;
  description: string;
  content: string;
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
  const userSkills = await loadUserSkills();
  const pluginSkills = await loadPluginSkills();

  // User skills take precedence over plugin skills with the same name
  const userSkillNames = new Set(userSkills.map(s => s.name));
  const merged = [
    ...userSkills,
    ...pluginSkills.filter(s => !userSkillNames.has(s.name)),
  ];

  return merged;
}

async function loadUserSkills(): Promise<SkillInfo[]> {
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
    const skill = await parseSkillFile(skillPath);
    if (skill) skills.push(skill);
  }

  return skills;
}

async function loadPluginSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  // Structure: ~/.claude/plugins/cache/{publisher}/{plugin}/{version}/skills/{skill}/SKILL.md
  let publishers: string[];
  try {
    const dirents = await fs.readdir(PLUGINS_CACHE_DIR, { withFileTypes: true });
    publishers = dirents.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return skills;
  }

  for (const publisher of publishers) {
    const publisherDir = join(PLUGINS_CACHE_DIR, publisher);
    let plugins: string[];
    try {
      const dirents = await fs.readdir(publisherDir, { withFileTypes: true });
      plugins = dirents.filter(d => d.isDirectory()).map(d => d.name);
    } catch {
      continue;
    }

    for (const plugin of plugins) {
      const pluginDir = join(publisherDir, plugin);
      let versions: string[];
      try {
        const dirents = await fs.readdir(pluginDir, { withFileTypes: true });
        versions = dirents.filter(d => d.isDirectory()).map(d => d.name);
      } catch {
        continue;
      }

      for (const version of versions) {
        const skillsDir = join(pluginDir, version, 'skills');
        let skillDirs: string[];
        try {
          const dirents = await fs.readdir(skillsDir, { withFileTypes: true });
          skillDirs = dirents.filter(d => d.isDirectory()).map(d => d.name);
        } catch {
          continue;
        }

        for (const skillDir of skillDirs) {
          const skillPath = join(skillsDir, skillDir, 'SKILL.md');
          const skill = await parseSkillFile(skillPath);
          if (skill) skills.push(skill);
        }
      }
    }
  }

  return skills;
}

async function parseSkillFile(path: string): Promise<SkillInfo | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (parsed.name && parsed.description) {
      // Strip frontmatter to get just the skill body
      const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
      return { name: parsed.name, description: parsed.description, content: body };
    }
  } catch {
    // File doesn't exist or can't be parsed
  }
  return null;
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
