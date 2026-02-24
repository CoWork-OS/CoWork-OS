import { type ComponentType } from "react";
import {
  Clock, Cloud, Scale, Zap, CheckSquare, PenLine, Pencil, Sparkles,
  Waves, Globe, CloudSun, Mic, SlidersHorizontal, Film, Palette, Gamepad2,
  Music, Building2, Home, Tag, Github, Bug, Bird, PawPrint, Eye,
  Users, Gem, Lightbulb, MessageCircle, DollarSign, CreditCard,
  FileText, Calendar, BookUser, TrendingUp, BarChart3, ClipboardList,
  Pin, MapPin, BookOpen, Library, ScrollText, FileEdit, Phone,
  Megaphone, Inbox, Package, Mail, Newspaper, Smartphone, Camera,
  Tv, ArrowLeftRight, Volume2, Search, Lock, KeyRound, Wrench,
  Microscope, Network, Image, Database, AudioLines, Map, Rocket,
  Hammer, Bike, Bot, Egg, Brain, Puzzle, FlaskConical, Compass,
  Magnet, Layers, Eraser, Receipt, CircleDot, Cherry,
  XCircle, AlertTriangle, Info,
  type LucideProps,
} from "lucide-react";

export type { LucideProps };

export const EMOJI_ICON_MAP: Record<string, ComponentType<LucideProps>> = {
  "⏰": Clock, "☁️": Cloud, "♊️": Sparkles, "⚖️": Scale, "⚡": Zap,
  "✅": CheckSquare, "✍️": PenLine, "✏️": Pencil, "✨": Sparkles,
  "🌊": Waves, "🌐": Globe, "🌤️": CloudSun, "🎙️": Mic,
  "🎛️": SlidersHorizontal, "🎞️": Film, "🎨": Palette, "🎮": Gamepad2,
  "🎵": Music, "🏗️": Building2, "🏠": Home, "🏷️": Tag,
  "🐙": Github, "🐛": Bug, "🐦": Bird, "🐻": PawPrint,
  "👀": Eye, "👁️": Eye, "👨‍👩‍👧‍👦": Users, "💎": Gem,
  "💡": Lightbulb, "💬": MessageCircle, "💰": DollarSign, "💳": CreditCard,
  "📄": FileText, "📅": Calendar, "📇": BookUser, "📈": TrendingUp,
  "📊": BarChart3, "📋": ClipboardList, "📌": Pin, "📍": MapPin,
  "📖": BookOpen, "📚": Library, "📜": ScrollText, "📝": FileEdit,
  "📞": Phone, "📣": Megaphone, "📥": Inbox, "📦": Package,
  "📧": Mail, "📨": Mail, "📰": Newspaper, "📱": Smartphone,
  "📸": Camera, "📺": Tv, "🔄": ArrowLeftRight, "🔊": Volume2,
  "🔍": Search, "🔎": Search, "🔐": KeyRound, "🔒": Lock,
  "🔧": Wrench, "🔬": Microscope, "🕸️": Network, "🖼️": Image,
  "🗄️": Database, "🗣️": AudioLines, "🗺️": Map, "🚀": Rocket,
  "🛠️": Hammer, "🛵": Bike, "🤖": Bot, "🥡": Egg,
  "🧠": Brain, "🧩": Puzzle, "🧪": FlaskConical, "🧭": Compass,
  "🧲": Magnet, "🧵": Layers, "🧹": Eraser, "🧾": Receipt,
  "🧿": CircleDot, "🫐": Cherry,
  // Heading-specific additions
  "❌": XCircle,
  "⚠️": AlertTriangle, "⚠": AlertTriangle,
  "ℹ️": Info, "ℹ": Info,
};
